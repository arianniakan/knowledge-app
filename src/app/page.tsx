"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  ArrowLeft,
  File,
  Link,
  Globe,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  User,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-4 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-black/10 px-1 py-0.5 text-xs">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded bg-black/10 p-2 text-xs last:mb-0">{children}</pre>
  ),
};

const GUEST_CHAT_STORAGE_KEY = "knowledge-app:guest-chat";
const GUEST_TIP_STORAGE_KEY = "knowledge-app:seen-guest-tip";
const COACHMARK_AUTO_DISMISS_MS = 9000;
// Vercel serverless functions reject request bodies over 4.5MB before our code
// even runs, so check client-side first for a fast, friendly error.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

type ChatSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

type ProjectRecord = {
  id: string;
  name: string;
  sourceIds: string[];
  createdAt: number;
  updatedAt: number;
};

function updateUrlState(projectId: string | null, chatId: string | null) {
  const url = new URL(window.location.href);
  if (projectId) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");
  if (chatId) url.searchParams.set("chat", chatId);
  else url.searchParams.delete("chat");
  window.history.replaceState({}, "", url.toString());
}

const initialMessages: UIMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Hi! Add a knowledge source on the left, then ask me anything about it.",
      },
    ],
  },
];

type SourceDialogType = "youtube" | "website" | null;

type Source = {
  id: string;
  label: string;
  type: "pdf" | "website" | "youtube";
  chunkCount: number;
  createdAt: number;
};

function Coachmark({
  show,
  onDismiss,
  children,
}: {
  show: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(onDismiss, COACHMARK_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [show, onDismiss]);

  // Dismiss on the next interaction anywhere on the page, not just the close button —
  // a first-time hint shouldn't require precisely hitting a tiny target.
  useEffect(() => {
    if (!show) return;
    const dismiss = () => onDismiss();
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [show, onDismiss]);

  if (!show) return null;

  return (
    <div className="absolute left-0 right-0 top-full z-20 mt-2 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="absolute -top-1 left-4 size-2 rotate-45 border-l border-t border-blue-200 bg-blue-50" />
      <div className="flex items-start justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 shadow-lg">
        <p>{children}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 shrink-0 rounded p-1 text-blue-900/60 hover:bg-blue-100 hover:text-blue-900"
          aria-label="Dismiss tip"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function TextPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  placeholder: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;

    onSubmit(trimmed);
    setValue("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setValue("");
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            className="mt-4"
          />
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>
              Submit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function extractApiError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") {
      return data.error;
    }
  } catch {
    // Response body wasn't JSON — fall through to the fallback below.
  }

  return fallback;
}

// Ingest responses can come from the platform itself (payload-too-large, function
// timeout) rather than our own route handler, so the body isn't guaranteed to be JSON.
async function extractIngestError(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const data = JSON.parse(text);
    if (data && typeof data.error === "string") {
      return data.error;
    }
  } catch {
    // Not JSON — fall through to status-based messages below.
  }

  if (response.status === 413) {
    return "That file is too large to upload. Try a file under 4MB.";
  }

  if (response.status === 504 || /timeout/i.test(text)) {
    return "This source took too long to process. Try a shorter document or a smaller website.";
  }

  return "Failed to ingest source.";
}

function getChatErrorMessage(error: Error): string {
  try {
    const parsed = JSON.parse(error.message);
    if (parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON — fall through to the raw message below.
  }

  if (error.message && error.message.length < 200) {
    return error.message;
  }

  return "Something went wrong while getting a response. Please try again.";
}

export default function Home() {
  const { data: session, status: sessionStatus } = useSession();
  const isDemo = sessionStatus !== "authenticated";

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatSummary[]>([]);
  const [hasLoadedChat, setHasLoadedChat] = useState(false);
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = useState(false);
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  const currentChatIdRef = useRef(currentChatId);
  const currentProjectIdRef = useRef(currentProjectId);
  const sessionStatusRef = useRef(sessionStatus);
  const hasLoadedChatRef = useRef(hasLoadedChat);

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);
  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);
  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);
  useEffect(() => {
    hasLoadedChatRef.current = hasLoadedChat;
  }, [hasLoadedChat]);

  const { messages, sendMessage, status, setMessages, error: chatError, clearError, regenerate } = useChat({
    messages: initialMessages,
    // eslint-disable-next-line react-hooks/refs -- body() is resolved at request time, not render time (see AI SDK `body` docs)
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({ projectId: currentProjectIdRef.current ?? undefined }),
    }),
    onError: (error) => {
      console.error("Chat error:", error);
    },
    onFinish: ({ messages: updatedMessages }) => {
      if (!hasLoadedChatRef.current) return;

      const projectId = currentProjectIdRef.current;
      const chatId = currentChatIdRef.current;

      if (sessionStatusRef.current === "authenticated" && projectId && chatId) {
        fetch(`/api/projects/${projectId}/chats/${chatId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: updatedMessages }),
        })
          .then(() => fetch(`/api/projects/${projectId}/chats`))
          .then((response) => response.json())
          .then((data) => setChatHistory(data.chats ?? []))
          .catch((error) => console.error("Failed to save chat:", error));
      } else if (sessionStatusRef.current !== "authenticated") {
        window.localStorage.setItem(GUEST_CHAT_STORAGE_KEY, JSON.stringify(updatedMessages));
      }
    },
  });

  const [input, setInput] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [openDialog, setOpenDialog] = useState<SourceDialogType>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [showGuestTip, setShowGuestTip] = useState(false);
  const [showProjectTip, setShowProjectTip] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = status === "submitted" || status === "streaming";

  // Reacting to a browser-only localStorage read, which can't happen during render (no window on the server).
  useEffect(() => {
    if (sessionStatus === "unauthenticated" && !window.localStorage.getItem(GUEST_TIP_STORAGE_KEY)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowGuestTip(true);
    }
  }, [sessionStatus]);

  const dismissGuestTip = () => {
    window.localStorage.setItem(GUEST_TIP_STORAGE_KEY, "1");
    setShowGuestTip(false);
  };

  useEffect(() => {
    fetch("/api/sources")
      .then((response) => response.json())
      .then((data) => setSources(data.sources ?? []))
      .catch((error) => console.error("Failed to load sources:", error));
  }, []);

  useEffect(() => {
    if (sessionStatus === "loading") return;

    let cancelled = false;

    const startFreshChatInProject = (projectId: string) => {
      const newId = crypto.randomUUID();
      if (cancelled) return;
      setCurrentChatId(newId);
      setMessages(initialMessages);
      updateUrlState(projectId, newId);
    };

    const loadChatsForProject = async (projectId: string) => {
      const listResponse = await fetch(`/api/projects/${projectId}/chats`);
      const listData = await listResponse.json();
      const chats: ChatSummary[] = listData.chats ?? [];
      if (!cancelled) setChatHistory(chats);

      const chatIdFromUrl = new URLSearchParams(window.location.search).get("chat");
      const targetChatId =
        chatIdFromUrl && chats.some((chat) => chat.id === chatIdFromUrl)
          ? chatIdFromUrl
          : chats[0]?.id;

      if (targetChatId) {
        const response = await fetch(`/api/projects/${projectId}/chats/${targetChatId}`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) {
            setCurrentChatId(targetChatId);
            setMessages(data.messages?.length ? data.messages : initialMessages);
            updateUrlState(projectId, targetChatId);
          }
        } else {
          startFreshChatInProject(projectId);
        }
      } else {
        startFreshChatInProject(projectId);
      }
    };

    const load = async () => {
      if (sessionStatus === "authenticated") {
        const listResponse = await fetch("/api/projects");
        const listData = await listResponse.json();
        let projectList: ProjectRecord[] = listData.projects ?? [];

        if (projectList.length === 0) {
          // First time signing in: skip the empty-list step and drop the user
          // straight into a ready-to-use project, pre-seeded from the demo content.
          const createResponse = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Sample Project (RAG demo)", seed: true }),
          });
          if (createResponse.ok) {
            const createData = await createResponse.json();
            projectList = [createData.project];

            const sourcesResponse = await fetch("/api/sources");
            const sourcesData = await sourcesResponse.json();
            if (!cancelled) {
              setSources(sourcesData.sources ?? []);
              setShowProjectTip(true);
            }
          }
        }

        if (!cancelled) setProjects(projectList);

        const projectIdFromUrl = new URLSearchParams(window.location.search).get("project");
        const targetProjectId =
          projectIdFromUrl && projectList.some((project) => project.id === projectIdFromUrl)
            ? projectIdFromUrl
            : (projectList[0]?.id ?? null);

        if (targetProjectId) {
          if (!cancelled) setCurrentProjectId(targetProjectId);
          await loadChatsForProject(targetProjectId);
        }
      } else {
        const stored = window.localStorage.getItem(GUEST_CHAT_STORAGE_KEY);
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as UIMessage[];
            if (!cancelled && parsed.length > 0) setMessages(parsed);
          } catch {
            // Ignore corrupt local storage.
          }
        }
      }

      if (!cancelled) setHasLoadedChat(true);
    };

    load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    setInput(event.target.value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isBusy) return;

    sendMessage({ text: trimmed });
    setInput("");
  };

  const ingestSource = async (formData: FormData) => {
    setIsProcessing(true);
    setIngestError(null);

    if (currentProjectId) {
      formData.append("projectId", currentProjectId);
    }

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await extractIngestError(response));
      }

      const data = await response.json();

      setSources((prev) => [
        ...prev,
        {
          id: data.id,
          label: data.source,
          type: data.type,
          chunkCount: data.chunks,
          createdAt: Date.now(),
        },
      ]);

      if (currentProjectId) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === currentProjectId
              ? { ...project, sourceIds: [...project.sourceIds, data.id] }
              : project,
          ),
        );
      }
    } catch (error) {
      console.error("Ingestion error:", error);
      setIngestError(
        error instanceof Error ? error.message : "Something went wrong while processing the source.",
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const deleteSource = async (id: string) => {
    const previousSources = sources;
    const previousProjects = projects;
    setSources((prev) => prev.filter((source) => source.id !== id));
    setProjects((prev) =>
      prev.map((project) => ({
        ...project,
        sourceIds: project.sourceIds.filter((sourceId) => sourceId !== id),
      })),
    );

    try {
      const response = await fetch(`/api/sources/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Failed to delete source.");
      }
    } catch (error) {
      console.error("Delete error:", error);
      setSources(previousSources);
      setProjects(previousProjects);
      setIngestError(
        error instanceof Error ? error.message : "Something went wrong while deleting the source.",
      );
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setIngestError("That file is too large to upload. Try a file under 4MB.");
      event.target.value = "";
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    await ingestSource(formData);

    event.target.value = "";
  };

  const handleAddSourceUrl = async (url: string) => {
    const formData = new FormData();
    const dialogType = openDialog;

    if (dialogType === "youtube") {
      formData.append("youtubeUrl", url);
    } else {
      formData.append("websiteUrl", url);
    }

    await ingestSource(formData);
  };

  const createProject = async (name: string) => {
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to create project."));
      }

      const data = await response.json();
      const project: ProjectRecord = data.project;

      setProjects((prev) => [project, ...prev]);
      setCurrentProjectId(project.id);
      setChatHistory([]);

      const newChatId = crypto.randomUUID();
      setCurrentChatId(newChatId);
      setMessages(initialMessages);
      updateUrlState(project.id, newChatId);
    } catch (error) {
      console.error("Create project error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to create project.");
    }
  };

  const openProject = async (projectId: string) => {
    setIsMobileSidebarOpen(false);
    setCurrentProjectId(projectId);
    setChatHistory([]);
    setMessages(initialMessages);

    try {
      const listResponse = await fetch(`/api/projects/${projectId}/chats`);
      if (!listResponse.ok) {
        throw new Error(await extractApiError(listResponse, "Failed to load this project's chats."));
      }

      const listData = await listResponse.json();
      const chats: ChatSummary[] = listData.chats ?? [];
      setChatHistory(chats);

      if (chats.length > 0) {
        const response = await fetch(`/api/projects/${projectId}/chats/${chats[0].id}`);
        if (response.ok) {
          const data = await response.json();
          setCurrentChatId(chats[0].id);
          setMessages(data.messages?.length ? data.messages : initialMessages);
          updateUrlState(projectId, chats[0].id);
          return;
        }
      }

      const newChatId = crypto.randomUUID();
      setCurrentChatId(newChatId);
      updateUrlState(projectId, newChatId);
    } catch (error) {
      console.error("Open project error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to open this project.");
    }
  };

  const backToProjects = () => {
    setCurrentProjectId(null);
    setCurrentChatId(null);
    setChatHistory([]);
    setMessages(initialMessages);

    const url = new URL(window.location.href);
    url.searchParams.delete("project");
    url.searchParams.delete("chat");
    window.history.replaceState({}, "", url.toString());
  };

  const deleteProjectHandler = async (projectId: string) => {
    const previous = projects;
    setProjects((prev) => prev.filter((project) => project.id !== projectId));

    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to delete project."));
      }

      if (projectId === currentProjectId) {
        const remaining = previous.filter((project) => project.id !== projectId);
        if (remaining.length > 0) {
          await openProject(remaining[0].id);
        } else {
          backToProjects();
        }
      }
    } catch (error) {
      console.error("Delete project error:", error);
      setProjects(previous);
      setIngestError(error instanceof Error ? error.message : "Failed to delete project.");
    }
  };

  const renameCurrentProject = async (name: string) => {
    if (!currentProjectId) return;

    try {
      const response = await fetch(`/api/projects/${currentProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to rename project."));
      }

      const data = await response.json();
      setProjects((prev) => prev.map((project) => (project.id === data.project.id ? data.project : project)));
    } catch (error) {
      console.error("Rename project error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to rename project.");
    }
  };

  const attachExistingSource = async (sourceId: string) => {
    if (!currentProjectId) return;

    try {
      const response = await fetch(`/api/projects/${currentProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addSourceId: sourceId }),
      });

      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to attach source."));
      }

      const data = await response.json();
      setProjects((prev) => prev.map((project) => (project.id === data.project.id ? data.project : project)));
    } catch (error) {
      console.error("Attach source error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to attach source.");
    }
  };

  const detachSourceFromProject = async (sourceId: string) => {
    if (!currentProjectId) return;

    try {
      const response = await fetch(`/api/projects/${currentProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeSourceId: sourceId }),
      });

      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to remove source from project."));
      }

      const data = await response.json();
      setProjects((prev) => prev.map((project) => (project.id === data.project.id ? data.project : project)));
    } catch (error) {
      console.error("Detach source error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to remove source from project.");
    }
  };

  const startNewChat = () => {
    if (!currentProjectId) return;
    setIsMobileSidebarOpen(false);
    const newId = crypto.randomUUID();
    setCurrentChatId(newId);
    setMessages(initialMessages);
    updateUrlState(currentProjectId, newId);
  };

  const openChat = async (chatId: string) => {
    if (!currentProjectId) return;
    setIsMobileSidebarOpen(false);

    try {
      const response = await fetch(`/api/projects/${currentProjectId}/chats/${chatId}`);
      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to open chat."));
      }

      const data = await response.json();
      setCurrentChatId(chatId);
      setMessages(data.messages?.length ? data.messages : initialMessages);
      updateUrlState(currentProjectId, chatId);
    } catch (error) {
      console.error("Open chat error:", error);
      setIngestError(error instanceof Error ? error.message : "Failed to open chat.");
    }
  };

  const deleteChatFromHistory = async (chatId: string) => {
    if (!currentProjectId) return;

    const previous = chatHistory;
    setChatHistory((prev) => prev.filter((chat) => chat.id !== chatId));

    try {
      const response = await fetch(`/api/projects/${currentProjectId}/chats/${chatId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await extractApiError(response, "Failed to delete chat."));
      }
      if (chatId === currentChatId) startNewChat();
    } catch (error) {
      console.error("Delete chat error:", error);
      setChatHistory(previous);
      setIngestError(error instanceof Error ? error.message : "Failed to delete chat.");
    }
  };

  const resetGuestConversation = () => {
    window.localStorage.removeItem(GUEST_CHAT_STORAGE_KEY);
    setMessages(initialMessages);
  };

  const unattachedSources = sources.filter(
    (source) => !currentProject?.sourceIds.includes(source.id),
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Mobile sidebar backdrop */}
      {isMobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar p-4 transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0",
          isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">
            Knowledge Sources
          </h2>
          <button
            type="button"
            onClick={() => setIsMobileSidebarOpen(false)}
            className="text-muted-foreground hover:text-foreground md:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative mb-4 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
          {sessionStatus === "authenticated" && session?.user ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                {session.user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={session.user.image} alt="" className="size-6 shrink-0 rounded-full" />
                ) : (
                  <User className="size-5 shrink-0" />
                )}
                <span className="truncate text-xs font-medium">{session.user.name}</span>
              </div>
              <button
                type="button"
                onClick={() => signOut()}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => signIn("github")}
              className="flex w-full items-center justify-center gap-2 text-xs font-medium text-foreground hover:underline"
            >
              <LogIn className="size-4" />
              Sign in with GitHub
            </button>
          )}

          {!isDemo && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Your data is removed after 7 days of inactivity.
            </p>
          )}

          {isDemo && (
            <Coachmark show={showGuestTip} onDismiss={dismissGuestTip}>
              Chat with the demo sources below, or sign in with GitHub to upload your own and unlock full
              features.
            </Coachmark>
          )}
        </div>

        {isDemo && (
          <>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button variant="outline" className="w-full justify-start" disabled>
                <File className="mr-2 size-4" />
                Upload PDF
              </Button>
              <Button variant="outline" className="w-full justify-start" disabled>
                <Link className="mr-2 size-4" />
                Add YouTube URL
              </Button>
              <Button variant="outline" className="w-full justify-start" disabled>
                <Globe className="mr-2 size-4" />
                Add Website
              </Button>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              You&apos;re viewing a shared read-only demo. Sign in with GitHub to add and manage your own
              sources.
            </p>

            <div className="mt-4 flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Demo Sources
              </h3>
              {sources.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {sources.map((source) => (
                    <li
                      key={source.id}
                      className="truncate rounded-md bg-background px-2 py-1.5 text-xs text-foreground"
                      title={source.label}
                    >
                      {source.label}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No demo sources yet.</p>
              )}
            </div>
          </>
        )}

        {!isDemo &&
          (currentProjectId && currentProject ? (
            <>
              <button
                type="button"
                onClick={backToProjects}
                className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                All Projects
              </button>

              <div className="relative mb-3 flex items-center justify-between gap-2">
                {isRenamingProject ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => {
                      setIsRenamingProject(false);
                      const trimmed = renameValue.trim();
                      if (trimmed && trimmed !== currentProject.name) {
                        renameCurrentProject(trimmed);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setIsRenamingProject(false);
                    }}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold text-foreground focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRenameValue(currentProject.name);
                      setIsRenamingProject(true);
                    }}
                    className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground hover:underline"
                    title="Click to rename"
                  >
                    {currentProject.name}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsNewProjectDialogOpen(true)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="New project"
                  title="New Project"
                >
                  <Plus className="size-4" />
                </button>

                <Coachmark show={showProjectTip} onDismiss={() => setShowProjectTip(false)}>
                  This sample project is pre-loaded so you can try it right away — click + to start a new
                  project for your own sources.
                </Coachmark>
              </div>

              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Sources in this project
                </h4>
                {currentProject.sourceIds.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {currentProject.sourceIds.map((sourceId) => {
                      const source = sources.find((candidate) => candidate.id === sourceId);
                      if (!source) return null;

                      return (
                        <li
                          key={sourceId}
                          className="group flex items-center justify-between gap-2 truncate rounded-md bg-background px-2 py-1.5 text-xs text-foreground"
                          title={source.label}
                        >
                          <span className="truncate">{source.label}</span>
                          <button
                            type="button"
                            onClick={() => detachSourceFromProject(sourceId)}
                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                            aria-label={`Remove ${source.label} from project`}
                          >
                            <X className="size-3.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No sources attached yet.</p>
                )}
              </div>

              {unattachedSources.length > 0 && (
                <div className="mt-3 flex flex-col gap-2">
                  <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Add from your library
                  </h4>
                  <ul className="flex flex-col gap-1">
                    {unattachedSources.map((source) => (
                      <li
                        key={source.id}
                        className="group flex items-center justify-between gap-2 truncate rounded-md border border-dashed border-border px-2 py-1.5 text-xs"
                        title={source.label}
                      >
                        <span className="truncate text-muted-foreground">{source.label}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => attachExistingSource(source.id)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={`Add ${source.label} to project`}
                          >
                            <Plus className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSource(source.id)}
                            className="text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                            aria-label={`Delete ${source.label} forever`}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing}
                >
                  <File className="mr-2 size-4" />
                  Upload PDF
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => setOpenDialog("youtube")}
                  disabled={isProcessing}
                >
                  <Link className="mr-2 size-4" />
                  Add YouTube URL
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => setOpenDialog("website")}
                  disabled={isProcessing}
                >
                  <Globe className="mr-2 size-4" />
                  Add Website
                </Button>
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                Note: right-to-left languages (Arabic, Persian, Hebrew) may not extract correctly from
                PDFs, and some websites block automated fetching.
              </p>

              {isProcessing && (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  Processing...
                </div>
              )}

              {ingestError && (
                <div className="mt-4 flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                  <span>{ingestError}</span>
                  <button
                    type="button"
                    onClick={() => setIngestError(null)}
                    className="shrink-0 text-destructive/70 hover:text-destructive"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Chat History
                  </h4>
                  <button
                    type="button"
                    onClick={startNewChat}
                    className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                  >
                    <Plus className="size-3.5" />
                    New Chat
                  </button>
                </div>
                {chatHistory.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {chatHistory.map((chat) => (
                      <li
                        key={chat.id}
                        className={`group flex items-center justify-between gap-2 truncate rounded-md px-2 py-1.5 text-xs ${
                          chat.id === currentChatId
                            ? "bg-secondary text-secondary-foreground"
                            : "bg-background text-foreground"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => openChat(chat.id)}
                          className="min-w-0 flex-1 truncate text-left"
                          title={chat.title}
                        >
                          {chat.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteChatFromHistory(chat.id)}
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                          aria-label={`Delete ${chat.title}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No past conversations yet.</p>
                )}
                <p className="text-[11px] text-muted-foreground">Conversations are kept for 7 days.</p>
              </div>
            </>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Projects
                </h3>
                <button
                  type="button"
                  onClick={() => setIsNewProjectDialogOpen(true)}
                  className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                >
                  <Plus className="size-3.5" />
                  New Project
                </button>
              </div>
              {projects.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {projects.map((project) => (
                    <li
                      key={project.id}
                      className="group flex items-center justify-between gap-2 truncate rounded-md bg-background px-2 py-1.5 text-xs text-foreground"
                    >
                      <button
                        type="button"
                        onClick={() => openProject(project.id)}
                        className="min-w-0 flex-1 truncate text-left"
                        title={project.name}
                      >
                        {project.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteProjectHandler(project.id)}
                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                        aria-label={`Delete ${project.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {hasLoadedChat
                    ? "No projects yet. Create one to add sources and start chatting."
                    : "Setting up your workspace..."}
                </p>
              )}

              {ingestError && (
                <div className="mt-4 flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
                  <span>{ingestError}</span>
                  <button
                    type="button"
                    onClick={() => setIngestError(null)}
                    className="shrink-0 text-destructive/70 hover:text-destructive"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              )}
            </>
          ))}
      </aside>

      <TextPromptDialog
        open={isNewProjectDialogOpen}
        onOpenChange={setIsNewProjectDialogOpen}
        title="New Project"
        description="Give your project a name. You can attach sources to it next."
        placeholder="e.g. Thesis Research"
        onSubmit={createProject}
      />

      <TextPromptDialog
        open={openDialog === "youtube"}
        onOpenChange={(open) => setOpenDialog(open ? "youtube" : null)}
        title="Add YouTube URL"
        description="Paste a YouTube video link to add it as a knowledge source."
        placeholder="https://www.youtube.com/watch?v=..."
        onSubmit={handleAddSourceUrl}
      />

      <TextPromptDialog
        open={openDialog === "website"}
        onOpenChange={(open) => setOpenDialog(open ? "website" : null)}
        title="Add Website"
        description="Paste a website URL to add it as a knowledge source."
        placeholder="https://example.com"
        onSubmit={handleAddSourceUrl}
      />

      {/* Main chat area */}
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-4 md:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsMobileSidebarOpen(true)}
              className="text-muted-foreground hover:text-foreground md:hidden"
              aria-label="Open sidebar"
            >
              <Menu className="size-5" />
            </button>
            <h1 className="text-lg font-semibold">Chat</h1>
          </div>
          <div className="flex items-center gap-3">
            {isDemo && (
              <button
                type="button"
                onClick={resetGuestConversation}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                title="Saved in this browser only"
              >
                <RotateCcw className="size-3.5" />
                Reset conversation
              </button>
            )}
            <ThemeToggle />
          </div>
        </header>

        {!isDemo && !currentProjectId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {sessionStatus === "authenticated" && !hasLoadedChat
                ? "Setting up your workspace..."
                : "Select or create a project on the left to start chatting."}
            </p>
          </div>
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1 px-6 py-4">
              <div className="flex flex-col gap-4">
                {messages.map((message) => {
                  const sourceParts = message.parts.filter(
                    (part) => part.type === "source-url",
                  ) as Array<{ type: "source-url"; sourceId: string; url: string; title?: string }>;

                  return (
                    <div
                      key={message.id}
                      className={`flex items-start gap-3 ${
                        message.role === "user" ? "flex-row-reverse" : ""
                      }`}
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                        {message.role === "user" ? (
                          <User className="size-4" />
                        ) : (
                          <MessageSquare className="size-4" />
                        )}
                      </div>
                      <div
                        className={`max-w-[70%] rounded-lg px-4 py-2 text-sm ${
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground"
                        }`}
                      >
                        {message.parts.map((part, index) =>
                          part.type === "text" ? (
                            <ReactMarkdown
                              key={index}
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {part.text}
                            </ReactMarkdown>
                          ) : null
                        )}
                        {sourceParts.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1 border-t border-border/40 pt-2">
                            {sourceParts.map((source) => (
                              <span
                                key={source.sourceId}
                                className="max-w-full truncate rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground"
                                title={source.title}
                              >
                                {source.title}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {status === "submitted" && (
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                      <MessageSquare className="size-4" />
                    </div>
                    <div className="flex items-center gap-1 rounded-lg bg-muted px-4 py-3">
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {chatError && (
              <div className="flex items-center justify-between gap-3 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
                <span>{getChatErrorMessage(chatError)}</span>
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => regenerate()}
                    className="hover:underline"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => clearError()}
                    className="text-destructive/70 hover:text-destructive"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="flex items-center gap-2 border-t border-border p-4"
            >
              <Input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask a question about your knowledge sources..."
                className="flex-1"
                autoComplete="off"
                disabled={isBusy}
              />
              <Button
                type="submit"
                size="icon"
                aria-label="Send message"
                disabled={isBusy || !input.trim()}
              >
                <Send className="size-4" />
              </Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
