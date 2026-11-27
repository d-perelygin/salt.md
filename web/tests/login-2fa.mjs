import assert from 'node:assert/strict';
import { eventually, withFixture } from './fixture.mjs';

// The 2FA field asks for six digits and nothing else: once the sixth arrives
// there is nothing left to decide, so the form signs in without a press on the
// button. Five digits must wait.
await withFixture(async ({ context, base }) => {
  const anon = await context.browser().newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' });
  const page = await anon.newPage();
  page.setDefaultTimeout(15000);
  const bodies = [];
  await page.route('**/api/login', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify(bodies.length === 1
        ? { error: 'Please enter the 6-digit code from your authenticator app.', code: '2fa_required' }
        : { error: 'Invalid code', code: '2fa_invalid' }),
    });
  });
  await page.goto(base + '/');
  await page.locator('input[type=email]').fill('someone@example.test');
  await page.locator('input[type=password]').fill('a-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const code = page.getByPlaceholder('2FA code (6 digits)');
  await code.waitFor();
  await code.pressSequentially('12345');
  await page.waitForTimeout(400);
  assert.equal(bodies.length, 1, 'five digits must not sign in by themselves');
  await code.pressSequentially('6');
  await eventually(async () => bodies.length === 2);
  assert.equal(bodies[1].code, '123456', 'the code travels with the automatic attempt');
  console.log('Login: the sixth digit sends the 2FA code by itself.');
  await anon.close();
});
