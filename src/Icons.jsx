/**
 * The app's icon set — lucide, in one place so the vocabulary stays small.
 *
 * Lucide's default stroke is a touch heavy next to Inter at these sizes, so
 * every icon is re-exported at 1.6.
 */
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Ghost,
  Download,
  FileText,
  Library,
  Link2,
  LogOut,
  MoreHorizontal,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  RotateCw,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Upload,
  Shapes,
  Sparkles,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react";

const thin = (Base, name) => {
  const Styled = (props) => <Base strokeWidth={1.6} {...props} />;
  Styled.displayName = name;
  return Styled;
};

export const IconArrowDown = thin(ArrowDown, "IconArrowDown");
export const IconArrowUp = thin(ArrowUp, "IconArrowUp");
export const IconCheck = thin(Check, "IconCheck");
export const IconChevronDown = thin(ChevronDown, "IconChevronDown");
export const IconChevronRight = thin(ChevronRight, "IconChevronRight");
export const IconCopy = thin(Copy, "IconCopy");
export const IconDownload = thin(Download, "IconDownload");
export const IconFileText = thin(FileText, "IconFileText");
export const IconGhost = thin(Ghost, "IconGhost");
export const IconLibrary = thin(Library, "IconLibrary");
export const IconLink = thin(Link2, "IconLink");
export const IconLogOut = thin(LogOut, "IconLogOut");
export const IconMoon = thin(Moon, "IconMoon");
export const IconMore = thin(MoreHorizontal, "IconMore");
export const IconPanel = thin(PanelLeft, "IconPanel");
export const IconPencil = thin(Pencil, "IconPencil");
export const IconPin = thin(Pin, "IconPin");
export const IconPlus = thin(Plus, "IconPlus");
export const IconRefresh = thin(RotateCw, "IconRefresh");
export const IconSearch = thin(Search, "IconSearch");
export const IconSettings = thin(Settings, "IconSettings");
export const IconShield = thin(Shield, "IconShield");
export const IconSliders = thin(SlidersHorizontal, "IconSliders");
export const IconArtifact = thin(Shapes, "IconArtifact");
export const IconCode = thin(Code2, "IconCode");
export const IconSparkles = thin(Sparkles, "IconSparkles");
export const IconStop = thin(Square, "IconStop");
export const IconSun = thin(Sun, "IconSun");
export const IconUpload = thin(Upload, "IconUpload");
export const IconTrash = thin(Trash2, "IconTrash");
export const IconX = thin(X, "IconX");
