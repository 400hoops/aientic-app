import { createContext, useContext } from "react";

/**
 * How a rendered answer hands an artifact up to whatever can open it.
 *
 * Context rather than a prop: the card is drawn deep inside react-markdown's
 * own component table, which is a module-level constant — threading a
 * callback down to it would mean rebuilding that table on every render of
 * every message, and the transcript re-renders on every streamed token.
 */
export const ArtifactContext = createContext(null);

export const useOpenArtifact = () => useContext(ArtifactContext);
