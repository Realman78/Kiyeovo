import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './electron';
import { timedStage } from './onboard';
import {
    setupThreePeerWorld,
    type ThreePeerWorld,
    WORLD_PASSWORD,
    fileBubble,
    sidebarChatEntry,
    openChat,
    attach,
    attachLogs,
} from './world';

// File-transfer coverage (round 2 of e2e/test-roadmap.md), run in a populated
// three-peer world (see e2e/world.ts) so wrong-chat routing and cross-chat
// contamination are assertable, not just "does a file arrive at all".
//
// --- Doc/code findings that shaped this spec (see the final report for the
// full trail) ---
//
// File picker: SendFileDialog.tsx's "Browse Files" (handleBrowse) calls
// window.kiyeovoAPI.showOpenDialog(), which is IPC_CHANNELS.SHOW_OPEN_DIALOG
// in src/electron/ipc-handlers.ts calling Electron's native
// `dialog.showOpenDialog()` directly — there is no <input type="file"> in
// this flow at all (confirmed by reading SendFileDialog.tsx and ChatInput.tsx
// in full), so Playwright cannot drive the picker via setInputFiles. The
// least invasive scriptable route is stubbing only the native
// `dialog.showOpenDialog` Electron API via ElectronApplication.evaluate() in
// the main process (see stubFilePicker below); the real IPC handler code
// around it — dialog-path-grant registration (dialog-path-grants.ts,
// required by the send path's own security check), size/metadata lookup,
// media-token minting — all still runs for real, unmodified. This exercises
// the actual send pipeline, not a bypass of it.
//
// Downloads directory: Kiyeovo_desktop_technical_documentation.md doesn't
// specify where `kiyeovo-downloads` resolves relative to; tracing the code
// (src/core/lib/file-storage.ts's resolveConfiguredDownloadsDirectory +
// src/core/constants.ts's DOWNLOADS_DIR) shows the default (no
// `downloads_directory` setting configured, which is the case for every fresh
// e2e profile) resolves `kiyeovo-downloads` **relative to `process.cwd()`**,
// not per-profile/per-HOME. Since e2e/electron.ts launches every instance
// with `cwd: repoRoot`, this means Bob's and Charlie's completed downloads in
// this suite land in the SAME shared `<repoRoot>/kiyeovo-downloads` directory
// (already gitignored, matching normal `npm run dev` behavior from the repo
// root) rather than inside each profile's isolated HOME — a real,
// code-confirmed finding, and the opposite of what a per-profile-HOME
// assumption would predict. Rather than rely on guessing the shared
// directory's collision-suffixed filename, findCompletedFilePath() below asks
// the app itself for the exact on-disk path via the same `messages:getMessages`
// IPC the chat UI already uses (raw DB row's `file_path` column — see
// MessagesContainer.tsx's mapDbMessage) — robust regardless of directory
// layout or filename collisions.
//
// Offline file delivery: this round's spec explicitly asked for offline file
// coverage. Kiyeovo_desktop_technical_documentation.md line ~952 states the UI
// copy "explains that the offer can arrive offline while the later download
// requires both peers online" (direct chats), but a separate line (~243)
// reads, in isolation, as if an offer to an offline recipient fails and its
// row is removed — an apparent contradiction. Tracing the actual code
// (src/core/lib/file-handler.ts's sendFile/sendGroupFile,
// src/core/lib/message-handler.ts's sendDirectApplicationMessage, and
// src/core/group/runtime/group-messaging.ts's sendApplicationMessage)
// resolves this: a file offer to an offline direct peer falls back to the
// same offline-DHT-bucket queuing text messages use
// (storeDirectApplicationMessageOffline) and is NOT removed — it settles
// 'awaiting_acceptance' on the sender side, same as a delivered offer. A group
// offer likewise always gets a best-effort offline-backup store
// (GroupOfflineManager.storeGroupMessage) regardless of gossip publish
// success, independent of message kind. The doc's "row is removed" line does
// not correspond to any actual row-deletion code path (chatSlice.ts's
// `removeMessageById` has zero call sites in src/) — it looks stale/aspirational
// relative to current behavior, which is "mark failed in place" on a genuine
// failure, never delete. The only real online-requirement is at *pull* time:
// acceptPendingFile()'s dial to the sender must succeed, i.e. the SENDER must
// be online when the recipient accepts — which is naturally satisfied here
// since only Charlie (the recipient) goes offline, not Alice (the sender).
// This is doc-and-code-confirmed supported behavior, not something being
// forced into the test — see the second test below, which also closes the
// "group-offline deliberately deferred" gap noted in test-roadmap.md's round 1
// entry (offline-delivery.spec.ts only covered direct messages).
//
// Given the world setup alone is real-DHT-heavy (three onboardings, two
// contact exchanges, one group create/invite/accept/activate round trip —
// group-chat.spec.ts calls this "the slowest suite in e2e/"), this file splits
// scenarios across two tests rather than one, each building its own world, to
// keep every individual test safely under the 6-minute cap and to keep a
// failure in one scenario from losing evidence for the others. This roughly
// doubles this file's total real-infra cost; noted in the final report per the
// standing "if the full suite exceeds ~4 min/run, note it" rule.

test.setTimeout(6 * 60_000);

const FILE_SIZE_BYTES = 200 * 1024; // ~200KB — several 32KB chunks (CHUNK_SIZE, src/core/constants.ts) without brushing the 10MB MAX_FILE_SIZE limit.

async function makeRandomFile(dir: string, name: string, sizeBytes = FILE_SIZE_BYTES): Promise<string> {
    const filePath = path.join(dir, name);
    await writeFile(filePath, randomBytes(sizeBytes));
    return filePath;
}

async function sha256(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Stubs Electron's native `dialog.showOpenDialog` (main process) to resolve
 * with the given path instead of opening a real OS picker. See the file-level
 * comment for why this is the chosen route over setInputFiles/paste.
 */
async function stubFilePicker(app: ElectronApplication, filePath: string): Promise<void> {
    await app.evaluate(({ dialog }, targetPath: string) => {
        dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [targetPath],
        })) as typeof dialog.showOpenDialog;
    }, filePath);
}

/** Drives paperclip -> Browse Files -> Send for the currently active chat on `page`. */
async function sendFileFromComposer(app: ElectronApplication, page: Page, filePath: string, fileName: string): Promise<void> {
    await stubFilePicker(app, filePath);
    await page.getByRole('button', { name: 'Open file picker' }).click();
    await expect(page.getByRole('heading', { name: 'Send File' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Browse Files', exact: true }).click();
    await expect(page.getByText(fileName, { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Waits for a file/image bubble with the given name to render at all (any transfer status). */
async function waitForOfferVisible(page: Page, fileName: string, timeout = 30_000): Promise<void> {
    await expect(fileBubble(page, fileName)).toBeVisible({ timeout });
}

/** Waits for the Accept button on a pending incoming offer, then clicks it. */
async function acceptFileOffer(page: Page, fileName: string, timeout = 30_000): Promise<void> {
    const acceptButton = fileBubble(page, fileName).getByRole('button', { name: 'Accept', exact: true });
    await expect(acceptButton).toBeVisible({ timeout });
    await acceptButton.click();
}

/**
 * Waits for the recipient's transfer to complete. Deliberately NOT a
 * "Completed" text assertion: FileMessage.tsx's transferStatusContent has no
 * branch at all for a completed non-group-sender row — a recipient's finished
 * card renders just name/size plus an icon-only "show in folder" button
 * (getStatusText()'s 'Completed' string is only rendered for the group
 * SENDER, via showsGroupSenderStandaloneStatus). The first run of this suite
 * failed on exactly that. Completion is detected the honest way instead: the
 * persisted message row reaching transfer_status='completed' with a
 * file_path — the same condition that makes the folder button render.
 */
async function waitForCompleted(page: Page, fileName: string, timeout = 90_000): Promise<void> {
    await expect.poll(
        () => findCompletedFilePath(page, fileName),
        {
            message: `transfer of ${fileName} never reached transfer_status='completed' in this peer's DB`,
            timeout,
            intervals: [1_000, 2_000],
        },
    ).toBeTruthy();
}

/**
 * Finds the on-disk path of a completed file/image message by file name,
 * searching every chat this profile has (file names are unique per run, so
 * one match is expected). Reads the same `messages:getMessages` IPC the chat
 * UI itself uses on load (MessagesContainer.tsx) — raw DB rows, so
 * `file_path`/`file_name`/`transfer_status` are the raw snake_case columns,
 * not the renderer's camelCase mapped shape.
 */
async function findCompletedFilePath(page: Page, fileName: string): Promise<string | null> {
    return page.evaluate(async (name) => {
        const chatsResult = await window.kiyeovoAPI.getChats();
        if (!chatsResult.success) return null;
        for (const chat of chatsResult.chats) {
            const messagesResult = await window.kiyeovoAPI.getMessages(chat.id, 200, 0);
            if (!messagesResult.success) continue;
            const match = (messagesResult.messages as Array<Record<string, unknown>>).find(
                (m) => m.file_name === name && m.transfer_status === 'completed' && !!m.file_path,
            );
            if (match) return match.file_path as string;
        }
        return null;
    }, fileName);
}

/** Hash-verifies a completed file against `expectedHash`, retrying briefly in case the DB row lags the UI's 'Completed' text. */
async function expectFileHashMatches(page: Page, fileName: string, expectedHash: string): Promise<void> {
    await expect(async () => {
        const filePath = await findCompletedFilePath(page, fileName);
        expect(filePath, `no completed row with file_name=${fileName} found via getMessages()`).toBeTruthy();
        const actualHash = await sha256(filePath!);
        expect(actualHash).toBe(expectedHash);
    }).toPass({ timeout: 15_000, intervals: [1_000] });
}

test('alice sends a file 1:1 and to the group in a populated world; wrong-chat routing holds @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let world: ThreePeerWorld | undefined;
    let scratchDir: string | undefined;
    let failed = false;

    try {
        scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-files-'));
        world = await setupThreePeerWorld({ basePort: 9121, label: 'file-transfer' });
        const { pageAlice, pageBob, pageCharlie, peerAlice, groupName, usernameAlice, usernameBob, usernameCharlie, runSuffix } = world;

        await attach(testInfo, pageAlice, 'world-ready-alice');
        await attach(testInfo, pageBob, 'world-ready-bob');
        await attach(testInfo, pageCharlie, 'world-ready-charlie');

        // --- Scenario a: 1:1 online file transfer, hash-verified ---
        const oneToOneFileName = `alice-1to1-${runSuffix}.bin`;
        const oneToOneFilePath = await makeRandomFile(scratchDir, oneToOneFileName);
        const oneToOneHash = await sha256(oneToOneFilePath);

        await timedStage('file-transfer', 'direct_file_offer', async () => {
            await openChat(pageAlice, usernameBob);
            await sendFileFromComposer(peerAlice.app, pageAlice, oneToOneFilePath, oneToOneFileName);
            await waitForOfferVisible(pageAlice, oneToOneFileName);
            await openChat(pageBob, usernameAlice);
            await waitForOfferVisible(pageBob, oneToOneFileName);
        });
        await attach(testInfo, pageAlice, 'a-direct-file-offered');
        await attach(testInfo, pageBob, 'b-direct-file-offer-received');

        await timedStage('file-transfer', 'direct_file_accept_and_download', async () => {
            await acceptFileOffer(pageBob, oneToOneFileName);
            await waitForCompleted(pageBob, oneToOneFileName);
        });
        await expectFileHashMatches(pageBob, oneToOneFileName, oneToOneHash);
        await attach(testInfo, pageBob, 'b-direct-file-completed');

        // --- Scenario b: wrong-chat guard — the 1:1 file must not leak into
        // Bob's group chat or anywhere on Charlie's side ---
        await timedStage('file-transfer', 'wrong_chat_guard', async () => {
            await openChat(pageBob, groupName);
            await expect(fileBubble(pageBob, oneToOneFileName)).toHaveCount(0);

            await openChat(pageCharlie, usernameAlice);
            await expect(fileBubble(pageCharlie, oneToOneFileName)).toHaveCount(0);
            await openChat(pageCharlie, groupName);
            await expect(fileBubble(pageCharlie, oneToOneFileName)).toHaveCount(0);
        });
        await attach(testInfo, pageBob, 'b-group-chat-no-direct-file');
        await attach(testInfo, pageCharlie, 'charlie-no-direct-file-anywhere');

        // --- Scenario c: group file, both members accept, hash-verified;
        // must not leak into either 1:1 chat ---
        const groupFileName = `alice-group-${runSuffix}.bin`;
        const groupFilePath = await makeRandomFile(scratchDir, groupFileName);
        const groupHash = await sha256(groupFilePath);

        await timedStage('file-transfer', 'group_file_offer', async () => {
            await openChat(pageAlice, groupName);
            await sendFileFromComposer(peerAlice.app, pageAlice, groupFilePath, groupFileName);
            await waitForOfferVisible(pageAlice, groupFileName);
            await openChat(pageBob, groupName);
            await waitForOfferVisible(pageBob, groupFileName);
            await openChat(pageCharlie, groupName);
            await waitForOfferVisible(pageCharlie, groupFileName);
        });
        await attach(testInfo, pageAlice, 'alice-group-file-offered');

        await timedStage('file-transfer', 'group_file_bob_accepts', async () => {
            await acceptFileOffer(pageBob, groupFileName);
            await waitForCompleted(pageBob, groupFileName);
        });
        await expectFileHashMatches(pageBob, groupFileName, groupHash);
        await attach(testInfo, pageBob, 'bob-group-file-completed');

        await timedStage('file-transfer', 'group_file_charlie_accepts', async () => {
            await acceptFileOffer(pageCharlie, groupFileName);
            await waitForCompleted(pageCharlie, groupFileName);
        });
        await expectFileHashMatches(pageCharlie, groupFileName, groupHash);
        await attach(testInfo, pageCharlie, 'charlie-group-file-completed');

        await timedStage('file-transfer', 'group_file_sender_sees_both_downloaded', async () => {
            // Sender's own row: FileMessage.tsx's isGroupSenderOffer branch
            // reports 'Completed' once every intended recipient has downloaded.
            await expect(fileBubble(pageAlice, groupFileName).getByText('Completed', { exact: true })).toBeVisible({ timeout: 30_000 });
        });
        await attach(testInfo, pageAlice, 'alice-group-file-both-downloaded');

        await timedStage('file-transfer', 'group_file_not_in_1to1_chats', async () => {
            await openChat(pageAlice, usernameBob);
            await expect(fileBubble(pageAlice, groupFileName)).toHaveCount(0);
            await openChat(pageAlice, usernameCharlie);
            await expect(fileBubble(pageAlice, groupFileName)).toHaveCount(0);
        });
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][file-transfer] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed && world) {
            await attachLogs(testInfo, world.peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, world.peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, world.peerCharlie, 'charlie-main-process-logs');
        }
        await world?.teardown();
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
});

test('a group file offer sent while a member is offline is delivered and downloads after they relaunch @slow', async () => {
    const testInfo = test.info();
    const testStart = Date.now();
    let world: ThreePeerWorld | undefined;
    let scratchDir: string | undefined;
    let failed = false;
    const basePort = 9124;
    const charlieP2pPort = basePort + 2;

    try {
        scratchDir = await mkdtemp(path.join(tmpdir(), 'kiyeovo-e2e-files-offline-'));
        world = await setupThreePeerWorld({ basePort, label: 'file-transfer-offline' });
        const { pageAlice, groupName, runSuffix } = world;
        const charlieProfileDir = world.peerCharlie.profileDir;

        await attach(testInfo, pageAlice, 'offline-world-ready-alice');

        // --- Charlie's app closes (real process exit), profile persists ---
        await timedStage('file-transfer-offline', 'charlie_closes_keeping_profile', async () => {
            await world!.peerCharlie.close({ keepProfile: true });
        });
        console.log(`[timing][file-transfer-offline] Charlie's profileDir kept at ${charlieProfileDir}`);

        // --- Alice sends a group file while Charlie is down ---
        const offlineFileName = `alice-group-offline-${runSuffix}.bin`;
        const offlineFilePath = await makeRandomFile(scratchDir, offlineFileName);
        const offlineHash = await sha256(offlineFilePath);

        await timedStage('file-transfer-offline', 'alice_sends_group_file_while_charlie_down', async () => {
            await openChat(pageAlice, groupName);
            await sendFileFromComposer(world!.peerAlice.app, pageAlice, offlineFilePath, offlineFileName);
            await waitForOfferVisible(pageAlice, offlineFileName);
        });
        await attach(testInfo, pageAlice, 'alice-sent-group-file-charlie-down');

        // --- Control: Bob (still online) receives + downloads normally,
        // proving the group keeps functioning with one member down ---
        await timedStage('file-transfer-offline', 'bob_accepts_while_charlie_down', async () => {
            await openChat(world!.pageBob, groupName);
            await waitForOfferVisible(world!.pageBob, offlineFileName);
            await acceptFileOffer(world!.pageBob, offlineFileName);
            await waitForCompleted(world!.pageBob, offlineFileName);
        });
        await expectFileHashMatches(world!.pageBob, offlineFileName, offlineHash);
        await attach(testInfo, world!.pageBob, 'bob-group-file-completed-while-charlie-down');

        // --- Charlie relaunches on the same profile (returning-user unlock,
        // same pattern as offline-delivery.spec.ts) ---
        await timedStage('file-transfer-offline', 'charlie_relaunch_returning_user_unlock', async () => {
            world!.peerCharlie = await launchApp({ p2pPort: charlieP2pPort, profileDir: charlieProfileDir });
            world!.pageCharlie = world!.peerCharlie.page;
            await world!.pageCharlie.waitForLoadState('domcontentloaded');
            await expect(world!.pageCharlie.getByText('UNLOCK IDENTITY')).toBeVisible({ timeout: 30_000 });
            await world!.pageCharlie.getByPlaceholder('Enter decryption key...').fill(WORLD_PASSWORD);
            await world!.pageCharlie.getByRole('button', { name: 'Decrypt & Access' }).click();
            await expect(sidebarChatEntry(world!.pageCharlie, groupName)).toBeVisible({ timeout: 60_000 });
        });
        await attach(testInfo, world.pageCharlie, 'charlie-relaunched-unlocked');

        // --- The deferred-coverage assertion: the group file offer sent
        // while Charlie was offline arrives once he reconnects, via the
        // group's offline catch-up path (doc/code-confirmed — see the
        // file-level comment above; this also closes round 1's
        // "group-offline deliberately deferred" gap for the file case) ---
        await timedStage('file-transfer-offline', 'charlie_receives_offer_after_reconnect', async () => {
            await openChat(world!.pageCharlie, groupName);
            await waitForOfferVisible(world!.pageCharlie, offlineFileName, 90_000);
        });
        await attach(testInfo, world.pageCharlie, 'charlie-sees-offline-group-file-offer');

        // --- Charlie accepts; Alice (the sender) is still online, so the
        // pull/download itself — which genuinely requires both peers online
        // at pull time, per doc + code — should succeed and hash-match ---
        await timedStage('file-transfer-offline', 'charlie_accepts_and_downloads', async () => {
            await acceptFileOffer(world!.pageCharlie, offlineFileName);
            await waitForCompleted(world!.pageCharlie, offlineFileName);
        });
        await expectFileHashMatches(world!.pageCharlie, offlineFileName, offlineHash);
        await attach(testInfo, world.pageCharlie, 'charlie-group-file-completed-after-reconnect');
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        console.log(`[timing][file-transfer-offline] TOTAL test: ${((Date.now() - testStart) / 1000).toFixed(1)}s`);
        if (failed && world) {
            await attachLogs(testInfo, world.peerAlice, 'alice-main-process-logs');
            await attachLogs(testInfo, world.peerBob, 'bob-main-process-logs');
            await attachLogs(testInfo, world.peerCharlie, 'charlie-main-process-logs');
        }
        await world?.teardown();
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
});
