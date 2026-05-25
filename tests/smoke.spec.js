const { test, expect } = require("@playwright/test");

async function mockExternalScripts(page) {
  await page.route("**/config.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.KH_CONFIG = { supabaseUrl: '', supabaseAnonKey: '', enableDemoData: false, superAdminUsername: 'superadmin', superAdminPasswordHash: 'e34f92a20532a873cb3184398070b4b82a8fa29cf48572c203dc5f0fa6158231' };"
    });
  });

  await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.supabase = undefined;"
    });
  });

  await page.route("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.html2canvas = async () => { throw new Error('html2canvas disabled in smoke tests'); };"
    });
  });

  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204, body: "" }));
}

async function gotoApp(page) {
  await mockExternalScripts(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#loginScreen")).toBeVisible();
}

async function loginAsCentre(page, centreName = "Tirur") {
  await page.getByRole("button", { name: "Centre" }).click();
  await page.locator("#loginCentre").selectOption({ label: centreName });
  await page.locator("#loginPassword").fill("1234");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#appShell")).toBeVisible();
  await expect(page.locator("#entryView")).toHaveClass(/active/);
}

async function loginAsAdmin(page) {
  await page.getByRole("button", { name: "Admin" }).click();
  await page.locator("#loginPassword").fill("admin123");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#appShell")).toBeVisible();
  await expect(page.locator("#adminView")).toHaveClass(/active/);
}

async function loginAsSuperAdmin(page) {
  await page.getByRole("button", { name: "Admin" }).click();
  await page.locator("#loginAdminUsername").fill("superadmin");
  await page.locator("#loginPassword").fill("superadmin123");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#appShell")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test("centre login opens the daily entry view", async ({ page }) => {
  await loginAsCentre(page);
  await expect(page.locator("#entryCentreName")).toContainText("Tirur");
  await expect(page.locator("#saveBtn")).toBeVisible();
});

test("centre daily entry saves to local storage", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator("#opEntry input").first().fill("42");
  await page.locator("#saveBtn").click();
  await expect(page.locator("#toast")).toContainText(/saved/i);

  const stored = await page.evaluate(() => localStorage.getItem("kh-cardio-ops-state-v1"));
  expect(stored).toBeTruthy();

  const parsed = JSON.parse(stored);
  const date = await page.locator("#entryDate").inputValue();
  expect(parsed.entries["0"][date].op["Total OP"]).toBe(42);
});

test("past entry dates show the request edit access flow", async ({ page }) => {
  await loginAsCentre(page);
  const pastDate = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 2);
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  });
  await page.locator("#entryDate").fill(pastDate);
  await expect(page.locator("#entryLockBanner")).toContainText("Request Edit Access");
});

test("centre petty cash entries can be added", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator('.nav-item[data-view="petty"]').click();
  await expect(page.locator("#pettyView")).toHaveClass(/active/);

  await page.locator("#pettyDate").fill(await page.locator("#entryDate").inputValue());
  await page.locator("#pettyParticulars").fill("Other Payments");
  await page.locator("#pettyPayments").fill("150");
  await page.locator("#pettyRemarks").fill("Smoke test entry");
  await page.locator("#pettySubmitBtn").click();

  await expect(page.locator("#toast")).toContainText(/petty entry saved/i);
  await expect(page.locator("#pettyRegisterTable tbody")).toContainText("Other Payments");
});

test("centre procedure advice entries can be added", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator('.nav-item[data-view="advice"]').click();
  await expect(page.locator("#adviceView")).toHaveClass(/active/);

  await page.locator("#adviceDate").fill(await page.locator("#entryDate").inputValue());
  await page.locator("#advicePatientName").fill("Smoke Test Patient");
  await page.locator("#adviceProcedure").fill("CAG");
  await page.locator("#adviceStatus").fill("Done here");
  await page.locator("#adviceRemarks").fill("Procedure advice smoke test");
  await page.locator("#adviceSubmitBtn").click();

  await expect(page.locator("#toast")).toContainText(/procedure advice saved/i);
  await expect(page.locator("#adviceTable tbody")).toContainText("Smoke Test Patient");
});

test("admin can open backup view and see backup status without crashing", async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.nav-item[data-view="backup"]').click();
  await expect(page.locator("#backupView")).toHaveClass(/active/);
  await expect(page.locator("#backupList")).toContainText(/No database connection|No backups yet|Loading backups/i);
  await expect(page.locator("#reportDateInput")).toBeVisible();
});

test("admin csv export downloads from the export menu", async ({ page }) => {
  await loginAsAdmin(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".topbar-actions .export-menu-button").click();
  await page.locator('.topbar-actions [data-export-format="csv"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.csv$/i);
});

test("admin png export downloads from the export menu", async ({ page }) => {
  await loginAsAdmin(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".topbar-actions .export-menu-button").click();
  await page.locator('.topbar-actions [data-export-format="png"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
});

test("admin professional report opens a printable popup", async ({ page }) => {
  await loginAsAdmin(page);
  const popupPromise = page.waitForEvent("popup");
  await page.locator(".topbar-actions .export-menu-button").click();
  await page.locator('.topbar-actions [data-export-format="pdf"]').click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup.locator("body")).toContainText("KH Operations Report");
});

test("admin can export and re-import a local backup file", async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.nav-item[data-view="backup"]').click();
  await expect(page.locator("#backupView")).toHaveClass(/active/);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Backup File" }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();

  await page.locator("#reportDateInput").fill("2026-05-01");
  await expect(page.locator("#reportDateInput")).toHaveValue("2026-05-01");

  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#importFileInput").setInputFiles(backupPath);

  await expect(page.locator("#importStatus")).toContainText(/Restore complete/i);
  await expect(page.locator("#toast")).toContainText(/Backup restored from file/i);
});

test("invalid backup import shows an error without overwriting data", async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.nav-item[data-view="backup"]').click();
  await expect(page.locator("#backupView")).toHaveClass(/active/);

  await page.locator("#importFileInput").setInputFiles({
    name: "invalid-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"invalid":true}', "utf8")
  });

  await expect(page.locator("#importStatus")).toContainText(/does not appear to be a KH backup/i);
});

test("centre advice download exports an excel file", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator('.nav-item[data-view="advice"]').click();
  await expect(page.locator("#adviceView")).toHaveClass(/active/);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#adviceDownloadBtn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
});

test("super admin notifications appear on an already open centre session", async ({ browser }) => {
  const context = await browser.newContext();
  const centrePage = await context.newPage();
  await gotoApp(centrePage);
  await loginAsCentre(centrePage);

  const superAdminPage = await context.newPage();
  await gotoApp(superAdminPage);
  await loginAsSuperAdmin(superAdminPage);
  await superAdminPage.locator('.nav-item[data-view="superadmin"]').click();
  await expect(superAdminPage.locator("#superadminView")).toHaveClass(/active/);

  await superAdminPage.locator("#notificationTitle").fill("Realtime update");
  await superAdminPage.locator("#notificationMessage").fill("This popup should appear without reloading the centre session.");
  await superAdminPage.locator("#notifyAllCentres").check();
  await superAdminPage.locator("#notificationSendBtn").click();
  await expect(superAdminPage.locator("#toast")).toContainText(/popup notification sent/i);

  await expect(centrePage.locator("#notificationModal")).toBeVisible();
  await expect(centrePage.locator("#notificationModalBody")).toContainText("without reloading");

  await centrePage.locator("#notificationModalDismiss").click();
  await expect(centrePage.locator("#notificationModal")).toBeHidden();

  await superAdminPage.close();
  await centrePage.close();
  await context.close();
});
