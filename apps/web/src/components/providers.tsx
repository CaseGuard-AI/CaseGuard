"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Direction } from "radix-ui";
import { useState, type ReactNode } from "react";
import { SessionProvider } from "@/components/auth/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ dir, children }: { dir: "ltr" | "rtl"; children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      {/* Radix menus and sheets read the reading direction from here (FR-LANG-2). */}
      <Direction.Provider dir={dir}>
        <TooltipProvider>
          <SessionProvider>{children}</SessionProvider>
        </TooltipProvider>
      </Direction.Provider>
    </QueryClientProvider>
  );
}
