/**
 * Categorize and auto-title chat conversations with a cheap/fast LLM call.
 * Single: POST { chatId, message, siteId } → title + category for a new chat.
 * Batch:  POST { chatIds, siteId } → categorizes existing chats from their titles.
 *
 * Every persisted title/category write audits `chat_mutated` / `rename` against the
 * conversation it changed — one row per chat, in batch mode too, so `targetId` stays
 * the dedup key for "did this conversation change?". Chats the batch skips (missing,
 * wrong site, not the caller's, nothing to categorize on, generation failed) write
 * nothing and audit nothing. Only a chat's owner can categorize it, as only they can
 * stop it; an autonomous chat has no owner.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText } from 'ai';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { createCheapModel } from '@/lib/llm';
import { resolveLlmConfig, verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import {
  CHAT_CATEGORIES,
  buildTitleCategoryPrompt,
  categorizeNewChat,
  parseChatCategory,
} from '@/lib/hoot/categorizeChat.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';
import { isUntitledChat } from '@/lib/hoot/untitledChat';
import { sanitizeForLog } from '@/lib/logSanitize';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    const body = await request.json();
    const { siteId } = body;

    if (!siteId) {
      return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
    }

    const db = getAdminDb();
    await verifyUserSiteAccess(db, userId, siteId);
    const llmConfig = await resolveLlmConfig(db, userId);
    const model = createCheapModel(llmConfig);

    const auditRename = (chatId: string, category: string, retitled: boolean) =>
      emitMutation({
        kind: 'chat_mutated',
        siteId,
        actor: `user:${userId}`,
        targetId: chatId,
        attributes: {
          verb: 'rename',
          endpoint: '/api/hoot/categorize',
          method: 'POST',
          siteId,
          category,
          retitled,
        },
      });

    if (body.chatIds && Array.isArray(body.chatIds)) {
      const results: Record<string, string> = {};

      // Chunked to stay under provider rate limits.
      const chunks: string[][] = [];
      for (let i = 0; i < body.chatIds.length; i += 5) {
        chunks.push(body.chatIds.slice(i, i + 5));
      }

      for (const chunk of chunks) {
        const promises = chunk.map(async (chatId: string) => {
          try {
            const chatDoc = await db.collection('chats').doc(chatId).get();
            const data = chatDoc.data();
            if (!chatDoc.exists || data?.siteId !== siteId) {
              console.warn(`[Categorize] Skipping chat ${sanitizeForLog(chatId)}: not found on site ${sanitizeForLog(siteId)}`);
              return;
            }
            if (data?.userId !== userId) {
              console.warn(`[Categorize] Skipping chat ${sanitizeForLog(chatId)}: not the caller's`);
              return;
            }

            // Needs a real title or a first message; "new conversation" is not
            // enough to categorize on.
            const title = data?.title;
            if (isUntitledChat(title)) {
              const messagesSnap = await db.collection('chats').doc(chatId)
                .collection('messages')
                .where('role', '==', 'user')
                .orderBy('createdAt', 'asc')
                .limit(1)
                .get();
              const firstMsg = messagesSnap.docs[0]?.data()?.content;
              if (!firstMsg) {
                console.log(`[Categorize] Skipping chat ${sanitizeForLog(chatId)}: no title or messages`);
                return;
              }

              const { text } = await generateText({
                model,
                prompt: buildTitleCategoryPrompt(
                  typeof firstMsg === 'string' ? firstMsg.slice(0, 500) : JSON.stringify(firstMsg).slice(0, 500),
                ),
              });

              const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
              const newTitle = lines[0]?.slice(0, 80) || 'untitled';
              const category = lines[1] ? parseChatCategory(lines[1]) : 'General';
              await db.collection('chats').doc(chatId).update({ title: newTitle, category });
              auditRename(chatId, category, true);
              results[chatId] = category;
              return;
            }

            const { text } = await generateText({
              model,
              prompt: `Categorize this IT/media-server management conversation into exactly one of: ${CHAT_CATEGORIES.join(', ')}.

Title: "${title}"

Reply with only the category name, nothing else.`,
            });

            const category = parseChatCategory(text);
            await db.collection('chats').doc(chatId).update({ category });
            auditRename(chatId, category, false);
            results[chatId] = category;
          } catch (err) {
            console.error(`[Categorize] Failed for chat ${sanitizeForLog(chatId)}:`, err);
          }
        });
        await Promise.all(promises);
      }

      return NextResponse.json({ results });
    }

    const { chatId, message } = body;
    if (!chatId || !message) {
      return NextResponse.json({ error: 'Missing chatId or message' }, { status: 400 });
    }

    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data()?.siteId !== siteId) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }
    if (chatDoc.data()?.userId !== userId) {
      return NextResponse.json({ error: 'you do not own this chat' }, { status: 403 });
    }

    const { title, category } = await categorizeNewChat(db, model, chatId, message);
    auditRename(chatId, category, true);

    return NextResponse.json({ title, category });
  } catch (error) {
    return apiError(error, 'hoot/categorize');
  }
}, { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession });
