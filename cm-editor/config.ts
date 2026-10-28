import { Facet } from '@codemirror/state';

// What the decoration builder needs to know about the app: where internal
// links point and which titles exist (for the exists/missing color-coding).
// Same contract as parser.ts's RenderOpts.
export interface LinkConfig {
  linkBase: string;
  knownTitles: Set<string>;
  fallback?: { linkBase: string; knownTitles: Set<string> };
}

export const linkConfig = Facet.define<LinkConfig, LinkConfig>({
  combine: (values) => values[0] ?? { linkBase: '#/page/', knownTitles: new Set() },
});
