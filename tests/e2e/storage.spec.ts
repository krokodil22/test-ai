import { test, expect } from '@playwright/test';
for (const cors of [true, false]) {
  test(`real second-origin storage, CORS ${cors ? 'enabled' : 'missing'}`, async ({ page, context }) => {
    const base = 'http://127.0.0.1:5176/models/qwen2.5-1.5b/';
    // Test-server control is outside the application's browser/network context.
    await page.request.post('http://127.0.0.1:5176/control', { data: { allowCors: cors } });
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    await page.goto('./');
    await expect(page.locator('#load-model')).toBeEnabled();
    expect(requests.filter(request => request.url.startsWith(base))).toHaveLength(0);
    await page.locator('#load-model').click();
    if (cors) {
      await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
      await page.locator('#prompt').fill('Секрет ПРИВАТНЫЙ-882');
      await page.locator('#send').click();
      await expect(page.locator('.message-assistant')).toContainText('Здравствуйте');
      await expect(page.locator('#stop')).toBeHidden();
      expect(requests.filter(request => request.url.startsWith(base))).toHaveLength(5);
    } else {
      await expect(page.locator('#notice')).toContainText('CORS');
      await expect(page.locator('#engine-status')).toContainText('не запущена');
    }
    for (const request of requests) {
      expect(['http://127.0.0.1:5175', 'http://127.0.0.1:5176']).toContain(new URL(request.url).origin);
      expect(request.url).not.toContain('ПРИВАТНЫЙ');
      expect(request.method).toBe('GET');
      expect(request.body).toBeNull();
    }
  });
}
