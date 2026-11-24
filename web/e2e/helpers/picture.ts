import { test, type Locator, type Page } from '@playwright/test';

/** attaches a picture of the open surface and 16 px around it, so its edges and shadow are in it */
export async function attachPicture(page: Page, surface: Locator, name: string): Promise<void> {
  const box = (await surface.boundingBox())!;
  const clip = { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
  await test.info().attach(name, { body: await page.screenshot({ clip }), contentType: 'image/png' });
}
