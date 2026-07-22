"use client";

import dynamic from "next/dynamic";

// React Flow touches window at module scope in places — keep the whole studio client-only.
const Studio = dynamic(() => import("@/components/Studio"), { ssr: false });

export default function Page() {
  return <Studio />;
}
