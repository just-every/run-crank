import {expect} from '@playwright/test';

/** Assert the real hover delay without racing the CI process scheduler. */
export async function expectHoverTooltip(page,control,tooltip) {
  await page.mouse.move(0,0);
  await control.blur();
  await expect(tooltip).toBeHidden();
  // Freeze Chromium's animation clock before entering the control: a handler
  // installed on mouseenter can miss transitions that already finished while
  // the browser was busy. Seek the shipped transitions to the same 150ms point
  // the old wall-clock sleep tried to observe, then resume their real playback.
  const session=await page.context().newCDPSession(page);
  const {playbackRate}=await session.send('Animation.getPlaybackRate');
  await session.send('Animation.enable');
  await session.send('Animation.setPlaybackRate',{playbackRate:0});
  try {
    await control.hover();
    await control.locator('[role="tooltip"]').evaluate(element=>{
      for(const animation of element.getAnimations())animation.currentTime=150;
    });
    await expect(tooltip).toBeHidden();
  } finally {
    await session.send('Animation.setPlaybackRate',{playbackRate});
    await session.detach();
  }
  await expect(tooltip).toBeVisible();
}
