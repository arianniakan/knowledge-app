"use client";

import { useEffect } from "react";

import { buttonVariants } from "@/components/ui/button";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error:", error);
  }, [error]);

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <p className="text-sm font-medium text-muted-foreground">Error</p>
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        An unexpected error occurred. You can try again, or refresh the page.
      </p>
      <button type="button" onClick={() => retry()} className={buttonVariants({ variant: "default", className: "mt-2" })}>
        Try again
      </button>
    </div>
  );
}
