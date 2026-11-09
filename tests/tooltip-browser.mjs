import {expect} from '@playwright/test';

/** Assert the real hover delay without racing the CI process scheduler. */
export async function expectHoverTooltip(page,control,tooltip) {
  await page.mouse.move(0,0);
  await control.blur();
  await expect(tooltip).toBeHidden();
  // Pause the native CSS transitions in the mouseenter task, before a delayed
  // Playwright command could miss the hidden interval. This changes only their
  // playback time, preserving the shipped styles and actual pointer interaction.
  await control.evaluate(element=>{
    element.addEventListener('mouseenter',()=>{
      const tip=element.querySelector('[role="tooltip"]');
      for(const animation of tip.getAnimations()) {
        animation.pause();
        animation.currentTime=150;
      }
    },{once:true});
  });
  await control.hover();
  try {
    await expect(tooltip).toBeHidden();
  } finally {
    await control.locator('[role="tooltip"]').evaluate(element=>{
      for(const animation of element.getAnimations())animation.play();
    });
  }
  await expect(tooltip).toBeVisible();
}
