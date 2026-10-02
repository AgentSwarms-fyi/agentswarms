// One glyph per node type, so the add menus, the canvas cards and the panel
// badge say what a node is before its label does. Keyed by kind as well as
// type: a database is a database whether it is read or written, but an HTTP
// source is a fetch and an HTTP target is a send.
import {
  ArrowDownUp,
  Code,
  Contact,
  Columns3,
  CopyMinus,
  Database,
  Eraser,
  FileSpreadsheet,
  FolderOpen,
  Funnel,
  GitMerge,
  Globe,
  Layers,
  LibraryBig,
  PaintBucket,
  Radio,
  Rss,
  Scissors,
  Send,
  ShieldCheck,
  Sigma,
  Sparkles,
  Tag,
  Terminal,
  Warehouse,
  Waves,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { EtlNode } from "@/utils/etl/codegen";

const SOURCE: Record<string, LucideIcon> = {
  catalog_asset: LibraryBig,
  object_storage: FolderOpen,
  database: Database,
  http_api: Globe,
  platform_dataset: FileSpreadsheet,
  lakehouse: Warehouse,
  ingest: Webhook,
  kafka: Radio,
  kinesis: Waves,
  pubsub: Rss,
  python: Code,
};

const TRANSFORM: Record<string, LucideIcon> = {
  filter: Funnel,
  select: Columns3,
  rename: Tag,
  derive: Sparkles,
  join: GitMerge,
  union: Layers,
  aggregate: Sigma,
  sort: ArrowDownUp,
  dedupe: CopyMinus,
  fill_nulls: PaintBucket,
  drop_nulls: Eraser,
  limit: Scissors,
  quality_gate: ShieldCheck,
  sql: Terminal,
  python: Code,
};

const TARGET: Record<string, LucideIcon> = {
  object_storage: FolderOpen,
  database: Database,
  lakehouse: Warehouse,
  http_api: Send,
  // A CRM push is a send with a destination that knows what a record is.
  saas: Contact,
};

const BY_KIND: Record<EtlNode["kind"], Record<string, LucideIcon>> = {
  source: SOURCE,
  transform: TRANSFORM,
  target: TARGET,
};

/** The icon for a node type, or nothing for a type the menus do not offer. */
export function nodeTypeIcon(kind: EtlNode["kind"], type: string): LucideIcon | undefined {
  return BY_KIND[kind]?.[type];
}
