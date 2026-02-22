/**
 * Shared lucide-react icon mocks.
 *
 * Usage in test files:
 *   vi.mock("lucide-react", () => lucideIcons);
 *   import { lucideIcons } from "../../helpers/mock-lucide.js";
 *
 * Or import individual icons:
 *   vi.mock("lucide-react", async () => {
 *     const { lucideIcons } = await import("../../helpers/mock-lucide.js");
 *     return lucideIcons;
 *   });
 */

function icon(name: string) {
  return (props: any) => {
    // Use createElement-style to avoid JSX in .ts files
    const _el = Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "svg"), {
      // For @testing-library: data-testid on the wrapper
    });
    // Return a props-compatible mock for React rendering
    return {
      $$typeof: Symbol.for("react.element"),
      type: "svg",
      props: { "data-testid": `${name}-icon`, ...props },
      key: null,
      ref: null,
    };
  };
}

export const lucideIcons: Record<string, ReturnType<typeof icon>> = {
  AlertTriangle: icon("alert-triangle"),
  Archive: icon("archive"),
  ArrowDown: icon("arrow-down"),
  ArrowLeft: icon("arrow-left"),
  ArrowRight: icon("arrow-right"),
  ArrowUp: icon("arrow-up"),
  Bot: icon("bot"),
  Calendar: icon("calendar"),
  CalendarDays: icon("calendar-days"),
  Check: icon("check"),
  CheckCircle: icon("check-circle"),
  CheckCircle2: icon("check-circle-2"),
  ChevronDown: icon("chevron-down"),
  ChevronLeft: icon("chevron-left"),
  ChevronRight: icon("chevron-right"),
  ChevronUp: icon("chevron-up"),
  Circle: icon("circle"),
  CircleDot: icon("circle-dot"),
  Clock: icon("clock"),
  Copy: icon("copy"),
  Download: icon("download"),
  Edit: icon("edit"),
  Edit2: icon("edit-2"),
  Edit3: icon("edit-3"),
  ExternalLink: icon("external-link"),
  Eye: icon("eye"),
  EyeOff: icon("eye-off"),
  File: icon("file"),
  FileText: icon("file-text"),
  Filter: icon("filter"),
  Flag: icon("flag"),
  Folder: icon("folder"),
  FolderOpen: icon("folder-open"),
  Globe: icon("globe"),
  GripVertical: icon("grip-vertical"),
  Hash: icon("hash"),
  Heart: icon("heart"),
  HelpCircle: icon("help-circle"),
  Home: icon("home"),
  Inbox: icon("inbox"),
  Info: icon("info"),
  Keyboard: icon("keyboard"),
  Layers: icon("layers"),
  Layout: icon("layout"),
  LayoutGrid: icon("layout-grid"),
  Link: icon("link"),
  List: icon("list"),
  ListTodo: icon("list-todo"),
  Loader2: icon("loader-2"),
  Lock: icon("lock"),
  LogOut: icon("log-out"),
  Mail: icon("mail"),
  Menu: icon("menu"),
  MessageCircle: icon("message-circle"),
  MessageSquare: icon("message-square"),
  Mic: icon("mic"),
  MicOff: icon("mic-off"),
  Minus: icon("minus"),
  Moon: icon("moon"),
  MoreHorizontal: icon("more-horizontal"),
  MoreVertical: icon("more-vertical"),
  Move: icon("move"),
  Music: icon("music"),
  Palette: icon("palette"),
  Pause: icon("pause"),
  PenLine: icon("pen-line"),
  Phone: icon("phone"),
  PhoneOff: icon("phone-off"),
  Pin: icon("pin"),
  Play: icon("play"),
  Plus: icon("plus"),
  PlusCircle: icon("plus-circle"),
  Power: icon("power"),
  Puzzle: icon("puzzle"),
  Redo: icon("redo"),
  RefreshCw: icon("refresh-cw"),
  Repeat: icon("repeat"),
  RotateCcw: icon("rotate-ccw"),
  Save: icon("save"),
  Search: icon("search"),
  Send: icon("send"),
  Settings: icon("settings"),
  Settings2: icon("settings-2"),
  Share: icon("share"),
  Shield: icon("shield"),
  ShieldCheck: icon("shield-check"),
  Sidebar: icon("sidebar"),
  Slash: icon("slash"),
  Sparkles: icon("sparkles"),
  Speaker: icon("speaker"),
  Square: icon("square"),
  Star: icon("star"),
  StopCircle: icon("stop-circle"),
  Sun: icon("sun"),
  Tag: icon("tag"),
  Tags: icon("tags"),
  Target: icon("target"),
  Terminal: icon("terminal"),
  Trash: icon("trash"),
  Trash2: icon("trash-2"),
  Undo: icon("undo"),
  Undo2: icon("undo-2"),
  Upload: icon("upload"),
  User: icon("user"),
  Volume2: icon("volume-2"),
  VolumeX: icon("volume-x"),
  Wand2: icon("wand-2"),
  X: icon("x"),
  XCircle: icon("x-circle"),
  Zap: icon("zap"),
};
