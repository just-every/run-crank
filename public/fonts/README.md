# Crank fonts

| Family | Used for | Files | Licence | Source |
| --- | --- | --- | --- | --- |
| Figtree | headings, the Crank wordmark and body text (run site, docs, Lobby, sign-in and the app) | `figtree/` (Latin, Latin Extended; weights 300–900) | `figtree/LICENSE.txt` (SIL Open Font License 1.1) | https://github.com/erikdkennedy/figtree |
| JetBrains Mono | code, field paths, the terminal and IDs | `jetbrains-mono/` (Latin, Latin Extended; weights 100–800) | `jetbrains-mono/LICENSE.txt` (SIL Open Font License 1.1) | https://github.com/JetBrains/JetBrainsMono |

The variable WOFF2 subsets come from Fontsource's distributions
(`@fontsource-variable/figtree` and `@fontsource-variable/jetbrains-mono` 5.3.0).

`/rer-theme.css` declares the faces and a metric-matched `Figtree Fallback`
on Arial, so text does not jump when the web font arrives, and the installer
serves them too; `/look.css` sets the page font. Every page links both once
and preloads only the Latin Figtree file. No page requests a third-party font
service.
