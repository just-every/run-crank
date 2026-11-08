// seedIcons() freezes the existing public files into the app/site build.
// A renderer used without a build has no known public directory to link.
declare const __RER_ICON_HEAD__: string | undefined
export const iconHead = typeof __RER_ICON_HEAD__ === 'undefined' ? '' : __RER_ICON_HEAD__
