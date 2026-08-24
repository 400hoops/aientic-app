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
  Copy,
  LogOut,
  Moon,
  PanelLeft,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Shield,
  SlidersHorizontal,
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
export const IconLogOut = thin(LogOut, "IconLogOut");
export const IconMoon = thin(Moon, "IconMoon");
export const IconPanel = thin(PanelLeft, "IconPanel");
export const IconPencil = thin(Pencil, "IconPencil");
export const IconPlus = thin(Plus, "IconPlus");
export const IconRefresh = thin(RotateCw, "IconRefresh");
export const IconSearch = thin(Search, "IconSearch");
export const IconShield = thin(Shield, "IconShield");
export const IconSliders = thin(SlidersHorizontal, "IconSliders");
export const IconStop = thin(Square, "IconStop");
export const IconSun = thin(Sun, "IconSun");
export const IconTrash = thin(Trash2, "IconTrash");
export const IconX = thin(X, "IconX");
