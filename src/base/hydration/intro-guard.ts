// One-time entrance ("intro") animations must not replay when React rebuilds part
// of the page after a hydration mismatch: a rebuilt element is a new node and its
// CSS animation would start again from zero. Intro elements carry `data-intro`
// (README.md in this folder). The root route renders, early in <head>:
//
//   <script dangerouslySetInnerHTML={{ __html: introGuardScript }} />
//   <style>{introCss}</style>
//
// The script, with no React state:
//  - records the intro clock t0, the start time of the first intro animation;
//  - while intros run, pins every inserted intro element's animations to t0. The
//    MutationObserver callback runs after React's commit and before the browser
//    paints, so a rebuilt element continues exactly where its predecessor was;
//  - once no intro animation is running, appends <style id="rer-intro-done">
//    turning intro animations off and stops observing, so a later rebuild shows
//    the final state. A <style> rather than an attribute on <html>: a
//    whole-document client render strips every attribute from <html> but keeps
//    <style> elements in <head>.
export const introGuardScript = `(function(){
var d=document,A='data-intro',t0=null,mo;
if(!d.getAnimations||!window.MutationObserver)return;
function intro(n){return n&&n.nodeType===1&&n.hasAttribute(A)}
function running(){return d.getAnimations().some(function(a){var t=a.effect&&a.effect.target;return a.animationName&&t&&t.isConnected&&intro(t)&&a.playState!=='finished'})}
d.addEventListener('animationstart',function(e){if(t0!==null||!intro(e.target))return;e.target.getAnimations().forEach(function(a){if(a.animationName&&a.startTime!==null&&(t0===null||a.startTime<t0))t0=a.startTime})},true);
d.addEventListener('animationend',function(e){if(!intro(e.target)||running()||d.getElementById('rer-intro-done'))return;var s=d.createElement('style');s.id='rer-intro-done';s.textContent='['+A+']{animation:none!important}';d.head.appendChild(s);mo.disconnect()},true);
mo=new MutationObserver(function(records){if(t0===null)return;records.forEach(function(r){[].forEach.call(r.addedNodes,function(n){if(n.nodeType!==1)return;var all=[].slice.call(n.querySelectorAll('['+A+']'));if(intro(n))all.push(n);all.forEach(function(el){el.getAnimations().forEach(function(a){if(a.animationName)a.startTime=t0})})})})});
mo.observe(d,{childList:true,subtree:true});
})()`

// Intros never run under reduced motion, whatever a seed's own rules say. A seed
// declares its intro keyframes and timing inside
// @media (prefers-reduced-motion: no-preference).
export const introCss = '@media (prefers-reduced-motion: reduce){[data-intro]{animation:none!important}}'
