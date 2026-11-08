import type { ArchivePolicy, Manifest, Part, Closing } from '@runeditrun/rer/internal/modules/portability/index.mjs';
declare const policy: ArchivePolicy;
export default policy;

/** Project an already verified archive onto current installation-local exclusions. */
export function restoreArchive(records: (Manifest|Part|Closing)[]): Promise<(Manifest|Part|Closing)[]>;
