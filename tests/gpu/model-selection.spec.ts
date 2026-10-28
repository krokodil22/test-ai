import { test, expect } from '@playwright/test';
import main from '../../scripts/model-source.json' with { type: 'json' };
import light from '../../scripts/light-model-source.json' with { type: 'json' };

for (const prefix of ['/', '/test-ai/']) {
  test(`production model settings work at ${prefix} before any model download`, async ({ page, context }) => {
    const requests: string[] = [];
    context.on('request', request => { if (request.url().includes('/models/')) requests.push(request.url()); });
    await page.goto(prefix);
    await page.locator('#settings-open').click();
    await expect(page.locator('#model-select')).toBeEnabled();
    await expect(page.locator('#model-select')).toHaveValue(main.directory);
    await expect(page.getByRole('combobox', { name: 'Режим памяти' })).toHaveValue('economy');
    await page.locator('#model-select').selectOption(light.directory);
    await expect(page.locator('#model-select')).toBeEnabled();
    await expect(page.locator('.model-label')).toHaveText(light.displayName);
    await expect(page.locator('#settings-model-requirements')).toContainText('2048');
    await expect(page.locator('#prompt')).toHaveAttribute('maxlength', '600');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (prefix === '/') await page.screenshot({ path: 'test-results/model-settings-mobile.png', fullPage: true });
    await page.reload(); await expect(page.locator('.model-label')).toHaveText(light.displayName);
    expect(requests).toHaveLength(0);
  });
}
