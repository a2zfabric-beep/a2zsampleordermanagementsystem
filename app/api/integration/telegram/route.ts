import { createClient as createSupabaseDirect } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import axios from 'axios';

export const dynamic = 'force-dynamic';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- HELPERS ---
async function sendTelegram(chatId: string, text: string, replyMarkup?: any, replyToId?: number) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup, reply_to_message_id: replyToId
    });
  } catch (err: any) { console.error('Telegram Send Error:', err.response?.data || err.message); }
}

async function editTelegram(chatId: string, messageId: number, text: string, replyMarkup?: any) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: replyMarkup
    });
  } catch (err: any) { console.error('Telegram Edit Error:', err.response?.data || err.message); }
}

async function answerCallback(callbackQueryId: string, text: string) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId, text
    });
  } catch (err: any) { console.error('Callback Answer Error:', err.message); }
}

const STAGE_NAMES: Record<number, string> = {
  1: "Fabric Procurement", 2: "Dyeing Stage", 3: "Printing Stage", 4: "Embroidery Stage", 5: "Pattern & Sampling"
};

function calculateSpent(start: string, end?: string) {
  const s = new Date(start).setHours(0, 0, 0, 0);
  const e = (end ? new Date(end) : new Date()).setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((e - s) / (1000 * 3600 * 24)));
}

// REPLACE WITH:
// --- DROPBOX HELPERS ---
async function getDropboxAccessToken(): Promise<string> {
  const res = await axios.post(
    'https://api.dropbox.com/oauth2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN!,
      client_id: process.env.DROPBOX_APP_KEY!,
      client_secret: process.env.DROPBOX_APP_SECRET!,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

async function dbxEnsureFolder(path: string) {
  try {
    const token = await getDropboxAccessToken();
    await axios.post('https://api.dropboxapi.com/2/files/create_folder_v2',
      { path, autorename: false },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    if (err.response?.status !== 409) {
      console.error('Dropbox folder error:', path, err.response?.data || err.message);
    }
  }
}

async function dbxUploadFile(dropboxPath: string, fileBuffer: Buffer) {
  try {
    const token = await getDropboxAccessToken();
    await axios.post('https://content.dropboxapi.com/2/files/upload',
      fileBuffer,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true, mute: false }),
        }
      }
    );
  } catch (err: any) {
    console.error('Dropbox upload error:', dropboxPath, err.response?.data || err.message);
  }
}
async function ensureTaggingFolders(sessionType: string, clientName: string, orderId: string, styleName: string) {
  const root = `/${sessionType === 'sample' ? 'Sample Approved' : 'Production Pieces'}`;
  const clientPath = `${root}/${clientName}`;
  const orderPath = `${clientPath}/${orderId}`;
  const stylePath = `${orderPath}/${styleName}`;
  // Each call is idempotent — 409 = already exists, silently ignored
  await dbxEnsureFolder(root);
  await dbxEnsureFolder(clientPath);
  await dbxEnsureFolder(orderPath);
  await dbxEnsureFolder(stylePath);
  return stylePath;
}

async function getTelegramFileBuffer(fileId: string): Promise<{ buffer: Buffer; ext: string } | null> {
  try {
    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const filePath: string = fileRes.data.result.file_path;
    const ext = filePath.split('.').pop() || 'jpg';
    const fileRes2 = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(fileRes2.data as ArrayBuffer);
    return { buffer, ext };
  } catch (err: any) {
    console.error('Telegram file fetch error:', err.message);
    return null;
  }
}

// --- TAGGING SYSTEM HELPERS ---
async function getMeasurementTemplate(supabase: any, garmentType: string) {
  const { data } = await supabase.from('measurement_templates').select('fields').eq('garment_type', garmentType).single();
  return data?.fields || [];
}

function generateMeasurementKeyboard(session: any) {
  const fields = session.remaining_fields || [];
  const buttons = fields.map((f: string) => ([{ text: f, callback_data: `ts_set_field_${f}` }]));
  buttons.push([{ text: "✅ FINISH / DONE", callback_data: "ts_confirm_done" }]);
  buttons.push([{ text: "🔄 Restart Selection", callback_data: `ts_cl_${session.session_type}_${session.client_id}` }]);
  return { inline_keyboard: buttons };
}

// --- UI GENERATORS ---
async function getOrderList(supabase: any) {
  const { data: orders } = await supabase.from('sample_orders').select('order_id, status, client:clients(name)').not('status', 'eq', 'dispatched').eq('is_deleted', false).order('created_at', { ascending: false }).limit(15);
  if (!orders || orders.length === 0) return { text: "📋 <b>No active orders found.</b>", keyboard: { inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]] } };
  const keyboard = { inline_keyboard: [...orders.map((o: any) => ([{ text: `${o.order_id} | ${o.client?.name || 'Client'} (${o.status})`, callback_data: `view_${o.order_id}` }])), [{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]] };
  return { text: "📋 <b>Active Orders List:</b>", keyboard };
}

async function getOrderDetail(supabase: any, orderId: string) {
  const { data: order } = await supabase.from('sample_orders').select('*, client:clients(name)').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Order not found.", keyboard: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_list" }]] } };
  const { data: styles } = await supabase.from('order_styles').select('*').eq('order_id', order.id);
  const text = `🔖 <b>ID:</b> <code>${order.order_id}</code>\n👤 <b>Client:</b> ${order.client?.name || 'N/A'}\n🏁 <b>Status:</b> <code>${order.status.toUpperCase()}</code>\n📅 <b>Target:</b> ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'Flexible'}\n\n👕 <b>Styles:</b>\n` +
    ((styles || []).map((s: any) => `• <code>${s.item_number || 'N/A'}</code>: ${s.style_name} (${s.quantity}pcs)`).join('\n') || '<i>No styles added</i>');

  const keyboard = {
    inline_keyboard: [
      [{ text: "⚙️ WORKFLOW TRACKER", callback_data: `wf_hub_${orderId}` }],
      [{ text: "🔬 Sampling", callback_data: `setstatus_${orderId}_sampling_in_progress` }, { text: "✅ Ready", callback_data: `setstatus_${orderId}_ready` }],
      [{ text: "🚚 DISPATCH ORDER", callback_data: `dispatch_prompt_${orderId}` }],
      [{ text: "📋 List", callback_data: "menu_list" }, { text: "🏠 Menu", callback_data: "menu_main" }]
    ]
  };
  return { text, keyboard };
}

async function getWorkflowHub(supabase: any, orderId: string) {
  const { data: order } = await supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Not found.", keyboard: null };
  const stages = order.production_workflow || {};
  let text = `⚙️ <b>Workflow Hub: ${orderId}</b>\n\n`;
  const buttons = [];
  for (let i = 1; i <= 5; i++) {
    const s = stages[i] || { status: 'pending', assignedDays: 0 };
    const icon = s.status === 'completed' ? '✅' : (s.status === 'in_progress' ? '🔵' : (s.status === 'na' ? '⚪' : '🕒'));
    const spent = s.startDate ? calculateSpent(s.startDate, s.actualDate) : 0;
    const delayWarn = (spent > s.assignedDays && s.assignedDays > 0 && s.status !== 'completed') ? '⚠️' : '';
    text += `${icon} <b>${STAGE_NAMES[i]}</b>\n   Status: <i>${s.status}</i>\n   Time: ${spent}d / ${s.assignedDays || 0}d ${delayWarn}\n\n`;
    buttons.push([{ text: `${icon} Manage ${STAGE_NAMES[i]}`, callback_data: `wf_stage_${orderId}_${i}` }]);
  }
  buttons.push([{ text: "⬅️ Back to Detail", callback_data: `view_${orderId}` }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

// WITH THIS:
async function getStageDetail(supabase: any, orderId: string, stageId: number) {
  const { data: order } = await supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Not found.", keyboard: null };
  const s = (order.production_workflow || {})[stageId] || { status: 'pending', assignedDays: 0 };
  const startDisplay = s.startDate ? new Date(s.startDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';
  const endDisplay = s.actualDate ? new Date(s.actualDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';
  let text = `🏗️ <b>${STAGE_NAMES[stageId]}</b>\nID: <code>${orderId}</code>\n\n📌 Status: <b>${s.status.toUpperCase()}</b>\n📅 Start Date: ${startDisplay}\n🏁 Completion Date: ${endDisplay}\n⏱ Budget: ${s.assignedDays} Days\n`;
  if (s.startDate) text += `⏳ Used So Far: ${calculateSpent(s.startDate, s.status === 'completed' ? s.actualDate : undefined)} Days\n`;

  const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const buttons = [
    [{ text: "✅ Mark Completed (Today)", callback_data: `wf_update_${orderId}_${stageId}_completed` }],
    [{ text: "📅 Set Start Date", callback_data: `wf_prompt_date_${orderId}_${stageId}_start` }],
    [{ text: "🏁 Set Completion Date", callback_data: `wf_prompt_date_${orderId}_${stageId}_end` }],
    [{ text: "⏱ Set Budget Days", callback_data: `wf_prompt_budget_${orderId}_${stageId}` }],
    [{ text: "🔄 Reset Stage", callback_data: `wf_reset_${orderId}_${stageId}` }],
    [{ text: "⬅️ Back to Workflow Hub", callback_data: `wf_hub_${orderId}` }]
  ];
  return { text, keyboard: { inline_keyboard: buttons } };
}

// --- MAIN ROUTE ---
export async function POST(request: Request) {
  try {
    const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
    // Use SERVICE_ROLE_KEY to perform admin actions safely on the server
    const supabase = createSupabaseDirect(
      process.env.NEXT_PUBLIC_SUPABASE_URL!, 
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const body = await request.json();

    if (body.callback_query) {
      const cb = body.callback_query;
      const adminId = cb.from.id.toString();
      const chatId = cb.message.chat.id.toString();
      const msgId = cb.message.message_id;
      const data = cb.data;
      if (adminId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

      // --- 1. TAGGING SETUP FLOW ---
      if (data.startsWith("ts_init_")) {
        const type = data.replace("ts_init_", "");
        const { data: clients } = await supabase.from('clients').select('id, name');
        const buttons = (clients || []).map(c => ([{ text: c.name, callback_data: `ts_cl_${type}_${c.id}` }]));
        await editTelegram(chatId, msgId, "👤 <b>Select Client:</b>", { inline_keyboard: buttons });
      }
      else if (data.startsWith("ts_cl_")) {
        const [_, __, type, clientId] = data.split("_");
        const { data: orders } = await supabase.from('sample_orders').select('order_id').eq('client_id', clientId).not('status', 'eq', 'dispatched');
        const buttons = (orders || []).map(o => ([{ text: `Order: ${o.order_id}`, callback_data: `ts_ord_${type}_${clientId}_${o.order_id}` }]));
        buttons.push([{ text: "🆕 Create New Entry", callback_data: `ts_ord_${type}_${clientId}_NEW` }]);
        await editTelegram(chatId, msgId, "🔖 <b>Select Reference:</b>", { inline_keyboard: buttons });
      }
      else if (data.startsWith("ts_ord_")) {
        const [_, __, type, clientId, orderRef] = data.split("_");
        const types = ["Top/Shirt/Tshirt", "Dress", "Trouser/Pant/Shorts", "Skirt"];
        const buttons = types.map(t => ([{ text: t, callback_data: `ts_gt_${type}_${clientId}_${orderRef}_${t}` }]));
        await editTelegram(chatId, msgId, "👗 <b>Select Garment Type:</b>", { inline_keyboard: buttons });
      }
      else if (data.startsWith("ts_gt_")) {
        const [_, __, type, clientId, orderId, gType] = data.split("_");
        const { data: styles } = await supabase.from('order_styles').select('style_name').eq('order_id', orderId);
        const buttons = (styles || []).map(s => ([{ text: s.style_name, callback_data: `ts_style_sel_${type}_${clientId}_${orderId}_${gType}_${s.style_name}` }]));
        buttons.push([{ text: "➕ Enter New Style Name", callback_data: `ts_style_new_${type}_${clientId}_${orderId}_${gType}` }]);
        await editTelegram(chatId, msgId, `👕 <b>Select Style for ${gType}:</b>`, { inline_keyboard: buttons });
      }
      // REPLACE WITH:
      else if (data.startsWith("ts_style_new_")) {
        const [_, __, ___, type, clientId, orderId, gType] = data.split("_");
        const tempId = orderId === "NEW" ? "TEMP-" + Date.now() : null;
        const effectiveOrderId = orderId === "NEW" ? tempId : orderId;
        const { data: clientData } = await supabase.from('clients').select('name').eq('id', clientId).single();
        const clientName = clientData?.name || clientId;
        await supabase.from('tagging_sessions').delete().eq('user_id', adminId);
        await supabase.from('tagging_sessions').insert([{
            user_id: adminId, session_type: type, client_id: clientId, client_name: clientName,
            order_id: orderId === "NEW" ? null : orderId, temp_entry_id: tempId,
            dropbox_order_id: effectiveOrderId, garment_type: gType,
            remaining_fields: [], current_field: "WAITING_FOR_STYLE_NAME"
        }]);
        await editTelegram(chatId, msgId, `✍️ <b>Type Style Name now:</b>`);
      }
      // REPLACE WITH:
      else if (data.startsWith("ts_style_sel_")) {
        const [_, __, ___, type, clientId, orderId, gType, styleName] = data.split("_");
        const fields = await getMeasurementTemplate(supabase, gType);
        // Fetch client name for Dropbox folder
        const { data: clientData } = await supabase.from('clients').select('name').eq('id', clientId).single();
        const clientName = clientData?.name || clientId;
        const effectiveOrderId = orderId === 'NEW' ? `TEMP-${Date.now()}` : orderId;
        // Create Dropbox folder hierarchy (idempotent)
        await ensureTaggingFolders(type, clientName, effectiveOrderId, styleName);
        await supabase.from('tagging_sessions').delete().eq('user_id', adminId);
        await supabase.from('tagging_sessions').insert([{
            user_id: adminId, session_type: type, client_id: clientId, client_name: clientName,
            order_id: orderId === 'NEW' ? null : orderId, dropbox_order_id: effectiveOrderId,
            garment_type: gType, style_name: styleName,
            remaining_fields: fields, current_field: "READY_FOR_MEDIA"
        }]);
        // ADD this line right before it:
        await supabase.from('debug_log').insert([{ context: 'ts_style_sel', payload: { clientName, effectiveOrderId, styleName, type, clientId } }]);
        await editTelegram(chatId, msgId, `📸 <b>Session Started: ${styleName}</b>\n\nRequired: <i>${fields.join(', ')}</i>\n\n📁 Dropbox folders ready.\n👉 Reply to any photo with <code>/map</code> to assign it.`);
      }
      // REPLACE WITH:
      else if (data.startsWith("ts_set_field_")) {
        const fieldName = data.replace("ts_set_field_", "");
        const originalMsg = cb.message.reply_to_message;
        if (!originalMsg) { await answerCallback(cb.id, "⚠️ Error: Reply to the photo!"); return NextResponse.json({ ok: true }); }
        const { data: session } = await supabase.from('tagging_sessions').select('*').eq('user_id', adminId).single();
        if (session) {
            const isPhoto = !!originalMsg.photo;
            const isVideo = !!originalMsg.video;
            const fileId = isPhoto ? originalMsg.photo[originalMsg.photo.length - 1].file_id : (isVideo ? originalMsg.video.file_id : originalMsg.document.file_id);
            const table = session.session_type === "sample" ? "sample_measurements" : "production_measurements";
            await supabase.from(table).insert([{ client_id: session.client_id, order_id: session.order_id, temp_entry_id: session.temp_entry_id, garment_type: session.garment_type, style_name: session.style_name, measurement_type: fieldName, file_id: fileId }]);
            const newRem = session.remaining_fields.filter((f: string) => f !== fieldName);
            await supabase.from('tagging_sessions').update({ remaining_fields: newRem }).eq('user_id', adminId);

            // --- DROPBOX UPLOAD ---
            const fileData: any = await getTelegramFileBuffer(fileId);
            if (fileData && session.client_name && session.style_name) {
              const stylePath = await ensureTaggingFolders(
                session.session_type,
                session.client_name,
                session.dropbox_order_id || session.order_id || session.temp_entry_id,
                session.style_name
              );
              // Filename: fieldName-originalFilename e.g. "Chest-photo.jpg"
              const safeField = fieldName.replace(/[^a-zA-Z0-9]/g, '_');
              const dropboxPath = `${stylePath}/${safeField}.${fileData.ext}`;
              await dbxUploadFile(dropboxPath, fileData.buffer);
            }

            await editTelegram(chatId, msgId, `✅ <b>${fieldName} Saved!</b>\nMap next photo or press FINISH.`, generateMeasurementKeyboard({...session, remaining_fields: newRem}));
        }
      }
      else if (data === "ts_confirm_done") {
        await editTelegram(chatId, msgId, "❓ <b>Is tagging complete for this style?</b>", { inline_keyboard: [[{ text: "✅ Yes, Finalize", callback_data: "ts_final_yes" }, { text: "⬅️ No, Go Back", callback_data: "ts_final_no" }]] });
      }
      else if (data === "ts_final_yes") {
        const { data: s } = await supabase.from('tagging_sessions').select('*').eq('user_id', adminId).single();
        if (s) { await sendTelegram(chatId, `✅ <b>Tagging Completed Successfully</b>\nStyle: ${s.style_name}\nRef: ${s.order_id || s.temp_entry_id}`); await supabase.from('tagging_sessions').delete().eq('user_id', adminId); }
      }
      else if (data === "ts_final_no") {
        const { data: s } = await supabase.from('tagging_sessions').select('*').eq('user_id', adminId).single();
        if (s) await editTelegram(chatId, msgId, `📸 <b>Continue Tagging: ${s.style_name}</b>`, generateMeasurementKeyboard(s));
      }

      // REPLACE WITH:
      // --- 2. TASK ASSIGNMENT SYSTEM ---
      else if (data.startsWith("asgn_mode_")) {
        const parts = data.split("_");
        const mode = parts[parts.length - 1];
        const mediaId = parts[2];
        const mediaDate = cb.message.reply_to_message
          ? new Date(cb.message.reply_to_message.date * 1000).toISOString()
          : new Date().toISOString();

        if (mode === "standalone") {
          const fileId = cb.message.reply_to_message?.photo
            ? cb.message.reply_to_message.photo[cb.message.reply_to_message.photo.length - 1].file_id
            : cb.message.reply_to_message?.video?.file_id || cb.message.reply_to_message?.document?.file_id || null;
          const sourceText = cb.message.reply_to_message?.text || null;
          const startDisplay = new Date(mediaDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
          const token = Buffer.from(JSON.stringify({ mediaDate, fileId: fileId || '', taskDesc: sourceText || '' })).toString('base64').replace(/=/g, '');
          const isFromText = !!sourceText && !fileId;
          const promptMsg = isFromText
            ? `🆕 <b>Standalone Task</b>\n📅 Start: <b>${startDisplay}</b>\n📋 Task: <i>${sourceText}</i>\n\nReply with:\n<code>Assigned To, Budget Days</code>\n\n<i>Example: Ayush, 3\nBudget days optional — just type name if no deadline</i>\n\nType <b>cancel</b> to abort.\n\n[STASK:${token}]`
            : `🆕 <b>Standalone Task</b>\n📅 Start: <b>${startDisplay}</b>\n\nReply with:\n<code>Assigned To | Nature of Task | Budget Days</code>\n\n<i>Example: Ayush | Stitching sample batch | 3\nBudget days optional</i>\n\nType <b>cancel</b> to abort.\n\n[STASK:${token}]`;
          await sendTelegram(chatId, promptMsg, { force_reply: true });
        } else {
          // Linked: select client first
          const { data: clients } = await supabase.from('clients').select('id, name');
          const buttons = (clients || []).map((c: any) => ([{ text: c.name, callback_data: `asgn_cl_${mediaId}_${c.id}` }]));
          await editTelegram(chatId, msgId, "👤 <b>Select Client:</b>", { inline_keyboard: buttons });
        }
      }
      else if (data.startsWith("asgn_cl_")) {
        const parts = data.split("_");
        const clientId = parts[parts.length - 1];
        const mediaId = parts[2];
        const { data: orders } = await supabase.from('sample_orders').select('order_id').eq('client_id', clientId).not('status', 'eq', 'dispatched');
        const buttons = (orders || []).map((o: any) => ([{ text: o.order_id, callback_data: `asgn_ord_${mediaId}_${clientId}_${o.order_id}` }]));
        if (buttons.length === 0) {
          await editTelegram(chatId, msgId, "❌ No active orders for this client.", { inline_keyboard: [[{ text: "⬅️ Back", callback_data: `asgn_mode_${mediaId}_associate` }]] });
        } else {
          await editTelegram(chatId, msgId, "📦 <b>Select Order:</b>", { inline_keyboard: buttons });
        }
      }
      else if (data.startsWith("asgn_ord_")) {
        const parts = data.split("_");
        const orderId = parts[parts.length - 1];
        const clientId = parts[parts.length - 2];
        const mediaId = parts[2];
        const stageButtons = [1, 2, 3, 4, 5].map(i => ([{ text: `${i}. ${STAGE_NAMES[i]}`, callback_data: `asgn_stg_${mediaId}_${clientId}_${orderId}_${i}` }]));
        await editTelegram(chatId, msgId, `🏗 <b>Select Stage for ${orderId}:</b>`, { inline_keyboard: stageButtons });
      }
      else if (data.startsWith("asgn_stg_")) {
        const parts = data.split("_");
        const stageId = parseInt(parts[parts.length - 1]);
        const orderId = parts[parts.length - 2];
        const clientId = parts[parts.length - 3];
        const mediaId = parts[2];
        const mediaDate = cb.message.reply_to_message
          ? new Date(cb.message.reply_to_message.date * 1000).toISOString()
          : new Date().toISOString();
        const fileId = cb.message.reply_to_message?.photo
          ? cb.message.reply_to_message.photo[cb.message.reply_to_message.photo.length - 1].file_id
          : cb.message.reply_to_message?.video?.file_id || cb.message.reply_to_message?.document?.file_id || null;

        const taskId = `TASK-${Math.floor(1000 + Math.random() * 9000)}`;
        await supabase.from('tasks').insert([{
          task_id: taskId, client_id: clientId, order_id: orderId,
          stage_id: stageId, stage_name: STAGE_NAMES[stageId],
          title: `${STAGE_NAMES[stageId]} — ${orderId}`,
          status: 'pending', is_standalone: false,
          start_date: mediaDate, start_file_id: fileId
        }]);

        // Also update production_workflow startDate for this stage
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', orderId).single();
        if (order) {
          const wf = order.production_workflow || {};
          wf[stageId] = { ...(wf[stageId] || { assignedDays: 0 }), status: 'in_progress', startDate: mediaDate };
          await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', orderId);
        }

        await editTelegram(chatId, msgId,
          `✅ <b>Task Created & Stage Started</b>\n🆔 <code>${taskId}</code>\n📦 Order: ${orderId}\n🏗 Stage: ${STAGE_NAMES[stageId]}\n📅 Start: ${new Date(mediaDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}\n\nReply to completion media with <code>/complete</code> to finish.`,
          { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "menu_main" }]] }
        );
      }
      // --- TASK: view detail before completing ---
      else if (data.startsWith("task_view_")) {
        // Format: task_view_{taskId}_ts_{unixTs}  OR legacy task_view_{taskId}
        const tsMatch = data.match(/^task_view_(TASK-\d+)_ts_(\d+)$/);
        const legacyMatch = data.match(/^task_view_(TASK-\d+)$/);
        const taskId = tsMatch ? tsMatch[1] : (legacyMatch ? legacyMatch[1] : null);
        const mediaTs = tsMatch ? parseInt(tsMatch[2]) : 0;
        if (!taskId) return NextResponse.json({ ok: true });
        const { data: task } = await supabase.from('tasks').select('*').eq('task_id', taskId).single();
        if (task) {
          const startStr = task.start_date ? new Date(task.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A';
          const dueStr = task.completion_date ? new Date(task.completion_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';
          const buttons: any[] = [
            [{ text: `✅ Complete — Today`, callback_data: `task_done_today_${taskId}` }],
            [{ text: `📅 Complete — Enter Date`, callback_data: `task_done_pickdate_${taskId}` }],
          ];
          if (mediaTs > 0) {
            const mediaDateStr = new Date(mediaTs * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            buttons.push([{ text: `📱 Complete via Media (${mediaDateStr})`, callback_data: `task_done_media_${taskId}_ts_${mediaTs}` }]);
          }
          buttons.push([{ text: `⬅️ Back`, callback_data: `task_back_list` }]);
          await editTelegram(chatId, msgId,
            `📋 <b>Task Detail</b>\n🆔 <code>${taskId}</code>\n👤 ${task.assigned_to || 'N/A'}\n📝 ${task.description || task.title || 'N/A'}\n📅 Started: ${startStr}\n🏁 Due: ${dueStr}`,
            { inline_keyboard: buttons }
          );
        }
      }

      // --- TASK: mark complete with today's date ---
      else if (data.startsWith("task_done_today_")) {
        const taskId = data.replace("task_done_today_", "");
        const completionDate = new Date().toISOString();
        const { data: task } = await supabase.from('tasks').select('*').eq('task_id', taskId).single();
        if (task) {
          await supabase.from('tasks').update({ status: 'completed', completion_date: completionDate }).eq('task_id', taskId);
          if (task.order_id && task.stage_id) {
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', task.order_id).single();
            if (order) {
              const wf = order.production_workflow || {};
              wf[task.stage_id] = { ...wf[task.stage_id], status: 'completed', actualDate: completionDate };
              await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', task.order_id);
            }
          }
          await editTelegram(chatId, msgId,
            `✅ <b>Task Completed!</b>\n🆔 <code>${taskId}</code>\n👤 ${task.assigned_to || ''}\n📋 ${task.description || task.title || ''}\n📅 Done: ${new Date(completionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`,
            { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "menu_main" }]] }
          );
        }
      }

      // --- TASK: prompt for manual completion date ---
      else if (data.startsWith("task_done_pickdate_")) {
        const taskId = data.replace("task_done_pickdate_", "");
        await sendTelegram(chatId,
          `📅 <b>Enter completion date</b> for <code>${taskId}</code>\n\nReply with: <code>DD-MM-YYYY</code>\n\n[TASK_COMPDATE:${taskId}]`,
          { force_reply: true }
        );
      }

      // --- TASK: mark complete using replied media/text message date ---
      else if (data.startsWith("task_done_media_")) {
        // Format: task_done_media_{taskId}_ts_{unixTs}
        const mediaMatch = data.match(/^task_done_media_(TASK-\d+)_ts_(\d+)$/);
        if (!mediaMatch) return NextResponse.json({ ok: true });
        const [, taskId, mediaTsStr] = mediaMatch;
        const completionDate = new Date(parseInt(mediaTsStr) * 1000).toISOString();
        const { data: task } = await supabase.from('tasks').select('*').eq('task_id', taskId).single();
        if (task) {
          await supabase.from('tasks').update({ status: 'completed', completion_date: completionDate }).eq('task_id', taskId);
          if (task.order_id && task.stage_id) {
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', task.order_id).single();
            if (order) {
              const wf = order.production_workflow || {};
              wf[task.stage_id] = { ...wf[task.stage_id], status: 'completed', actualDate: completionDate };
              await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', task.order_id);
            }
          }
          await editTelegram(chatId, msgId,
            `✅ <b>Task Completed!</b>\n🆔 <code>${taskId}</code>\n👤 ${task.assigned_to || ''}\n📋 ${task.description || task.title || ''}\n📅 Done: ${new Date(completionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}\n📱 <i>Date from replied message</i>`,
            { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "menu_main" }]] }
          );
        }
      }

      // --- TASK: back to pending list ---
      else if (data === "task_back_list") {
        const { data: tasks } = await supabase.from('tasks').select('*').eq('status', 'pending').order('created_at', { ascending: false });
        if (!tasks || tasks.length === 0) { await editTelegram(chatId, msgId, "✅ No pending tasks found.", { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "menu_main" }]] }); return NextResponse.json({ ok: true }); }
        const buttons = tasks.map((t: any) => ([{
          text: t.is_standalone
            ? `🆕 ${t.assigned_to || 'N/A'} | ${(t.description || t.title || t.task_id).substring(0, 35)}`
            : `📦 ${t.order_id} | ${t.stage_name}`,
          callback_data: `task_view_${t.task_id}_ts_0`
        }]));
        await editTelegram(chatId, msgId, `🏁 <b>Select task to complete:</b>`, { inline_keyboard: buttons });
      }
      // --- STANDALONE TASK: set date prompt ---
      else if (data.startsWith("stask_setdate_")) {
        const parts = data.split("_");
        const dateType = parts[parts.length - 1];
        const taskId = parts.slice(2, parts.length - 1).join("_");
        const label = dateType === "start" ? "Start Date" : "Due Date";
        await sendTelegram(chatId,
          `📅 <b>Set ${label}</b> for <code>${taskId}</code>\n\nReply with: <code>DD-MM-YYYY</code>\n\n[STASK_DATE:${taskId}_${dateType}]`,
          { force_reply: true }
        );
      }

      // --- 3. MENU & HUB ---
      else if (data === "menu_main") {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "⏳ Pending Tasks", callback_data: "menu_pending" }]] };
        await editTelegram(chatId, msgId, "🏠 <b>Admin Dashboard</b>", mainKeyboard);
      }
      else if (data === "menu_stats") {
        const { count: total } = await supabase.from('sample_orders').select('*', { count: 'exact', head: true }).not('status', 'eq', 'dispatched');
        const { count: ready } = await supabase.from('sample_orders').select('*', { count: 'exact', head: true }).eq('status', 'ready');
        const statText = `📊 <b>System Stats</b>\n\nActive Orders: <b>${total || 0}</b>\nReady for Dispatch: <b>${ready || 0}</b>`;
        await editTelegram(chatId, msgId, statText, { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_main" }]] });
      }
      // REPLACE WITH:
      else if (data === "menu_pending") {
        const { data: tasks } = await supabase.from('tasks').select('*').eq('status', 'pending').order('created_at', { ascending: false });
        const { data: orders } = await supabase.from('sample_orders').select('order_id, production_workflow, client:clients(name)').not('status', 'eq', 'dispatched');
        let response = "⏳ <b>Pending Tasks</b>\n\n";
        const todayMs = new Date().setHours(0, 0, 0, 0);

        const linked = (tasks || []).filter((t: any) => !t.is_standalone);
        const standalone = (tasks || []).filter((t: any) => t.is_standalone);

        if (standalone.length > 0) {
          response += "🆕 <b>Standalone Tasks:</b>\n";
          standalone.forEach((t: any) => {
            const startStr = t.start_date ? new Date(t.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'N/A';
            let dueLine = '📅 No due date set';
            if (t.completion_date) {
              const diff = Math.ceil((new Date(t.completion_date).setHours(0,0,0,0) - todayMs) / 86400000);
              if (diff > 0) dueLine = `🟢 ${diff}d left`;
              else if (diff === 0) dueLine = `⚠️ Due today`;
              else dueLine = `🔴 ${Math.abs(diff)}d overdue`;
            }
            response += `🆔 <code>${t.task_id}</code>\n👤 ${t.assigned_to || 'N/A'} | 📋 ${t.description || t.title || 'N/A'}\n📅 Start: ${startStr} | ${dueLine}\n\n`;
          });
        }

        if (linked.length > 0) {
          response += "🔗 <b>Linked Tasks:</b>\n";
          linked.forEach((t: any) => {
            const startStr = t.start_date ? new Date(t.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'N/A';
            response += `📦 <code>${t.order_id}</code> | ${t.stage_name}\n🆔 ${t.task_id} | 📅 ${startStr}\n\n`;
          });
        }

        if (orders && orders.length > 0) {
          const activeStages = (orders || []).filter((o: any) => {
            const wf = o.production_workflow || {};
            return Object.keys(wf).some(k => wf[k].status === 'in_progress');
          });
          if (activeStages.length > 0) {
            response += "⚙️ <b>Active Workflow Stages:</b>\n";
            activeStages.forEach((o: any) => {
              const wf = o.production_workflow || {};
              const actId = Object.keys(wf).find(k => wf[k].status === 'in_progress');
              if (actId) {
                const s = wf[actId];
                const budget = s.assignedDays || 0;
                const due = new Date(new Date(s.startDate).getTime() + budget * 86400000);
                const diff = Math.ceil((due.getTime() - todayMs) / 86400000);
                const dueStr = budget > 0 ? (diff > 0 ? `🟢 ${diff}d left` : diff === 0 ? `⚠️ Due today` : `🔴 ${Math.abs(diff)}d overdue`) : 'No budget set';
                response += `👤 ${o.client?.name || 'N/A'} | <code>${o.order_id}</code>\n📍 ${STAGE_NAMES[parseInt(actId)]} | ${dueStr}\n\n`;
              }
            });
          }
        }

        if (standalone.length === 0 && linked.length === 0 && response === "⏳ <b>Pending Tasks</b>\n\n") response += "✅ All clear — no pending tasks.";
        await editTelegram(chatId, msgId, response, { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_main" }]] });
      }
      else if (data === "menu_list") {
        const { text, keyboard } = await getOrderList(supabase);
        await editTelegram(chatId, msgId, text, keyboard);
      }
      else if (data.startsWith("view_")) {
        const { text, keyboard } = await getOrderDetail(supabase, data.replace("view_", ""));
        await editTelegram(chatId, msgId, text, keyboard);
      }
      else if (data.startsWith("wf_hub_")) {
        const { text, keyboard } = await getWorkflowHub(supabase, data.replace("wf_hub_", ""));
        if (keyboard) await editTelegram(chatId, msgId, text, keyboard);
      }
      else if (data.startsWith("wf_stage_")) {
        const [_, __, oId, sId] = data.split("_");
        const { text, keyboard } = await getStageDetail(supabase, oId, parseInt(sId));
        if (keyboard) await editTelegram(chatId, msgId, text, keyboard);
      }
      // REPLACE WITH:
      else if (data.startsWith("wf_prompt_budget_")) {
        const [_, __, ___, oId, sId] = data.split("_");
        await sendTelegram(chatId, `🔢 <b>Set Budget (Days) for ${STAGE_NAMES[parseInt(sId)]}</b>\nID: <code>${oId}</code>\n\nReply with a number (e.g. 5)`, { force_reply: true });
      }
      else if (data.startsWith("wf_prompt_date_")) {
        // data format: wf_prompt_date_{orderId}_{stageId}_{start|end}
        const parts = data.split("_");
        const dateType = parts[parts.length - 1]; // "start" or "end"
        const sId = parts[parts.length - 2];
        const oId = parts.slice(3, parts.length - 2).join("_");
        const todayStr = new Date().toISOString().split('T')[0];
        const label = dateType === "start" ? "Start Date" : "Completion Date";
        await sendTelegram(
          chatId,
          `📅 <b>Set ${label} for ${STAGE_NAMES[parseInt(sId)]}</b>\nID: <code>${oId}</code>\n\nReply with date in format: <code>DD-MM-YYYY</code>\n(Default today: <code>${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')}</code>)`,
          { force_reply: true }
        );
      }
      // REPLACE WITH:
      else if (data.startsWith("wf_update_")) {
        const [_, __, oId, sId, status] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            // Guard: prior stage must be completed or na before this one can be completed
            if (status === 'completed' && stageNum > 1) {
              const prev = stages[stageNum - 1];
              if (!prev || (prev.status !== 'completed' && prev.status !== 'na')) {
                await editTelegram(chatId, msgId,
                  `⛔ <b>Cannot complete ${STAGE_NAMES[stageNum]}</b>\n\n<b>${STAGE_NAMES[stageNum - 1]}</b> must be completed first.`,
                  { inline_keyboard: [[{ text: `⬅️ Back to Hub`, callback_data: `wf_hub_${oId}` }]] }
                );
                return NextResponse.json({ ok: true });
              }
            }
            const now = new Date().toISOString();
            stages[stageNum] = {
              ...stages[stageNum],
              status,
              actualDate: status === 'completed' ? (stages[stageNum].actualDate || now) : stages[stageNum].actualDate,
              startDate: stages[stageNum].startDate || now,
            };
            if (status === 'completed' && stageNum < 5) {
                if (!stages[stageNum + 1]) stages[stageNum + 1] = { status: 'in_progress', assignedDays: 0, startDate: now };
                else { stages[stageNum + 1].status = 'in_progress'; stages[stageNum + 1].startDate = stages[stageNum + 1].startDate || now; }
            }
            await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId);
            const { text, keyboard } = await getWorkflowHub(supabase, oId);
            if (keyboard) await editTelegram(chatId, msgId, text, keyboard);
        }
      }
      // REPLACE WITH:
      else if (data.startsWith("wf_reset_")) {
        const [_, __, oId, sId] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('status, production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            // Block reset if any later stage is not pending
            let blockingStage = 0;
            for (let i = stageNum + 1; i <= 5; i++) {
              if (stages[i] && stages[i].status !== 'pending') { blockingStage = i; break; }
            }
            if (blockingStage > 0) {
              await editTelegram(chatId, msgId,
                `⛔ <b>Cannot Reset ${STAGE_NAMES[stageNum]}</b>\n\n<b>${STAGE_NAMES[blockingStage]}</b> is still active.\nReset Stage ${blockingStage} first, then come back.`,
                { inline_keyboard: [[{ text: `🔄 Go to Stage ${blockingStage}`, callback_data: `wf_stage_${oId}_${blockingStage}` }], [{ text: "⬅️ Back to Hub", callback_data: `wf_hub_${oId}` }]] }
              );
              return NextResponse.json({ ok: true });
            }
            // Cascade reset: reset target stage and all later stages
            for (let i = stageNum; i <= 5; i++) {
              stages[i] = { ...(stages[i] || {}), status: 'pending', actualDate: null, startDate: null };
            }
            // Special: preserve mode/poConfirmed clearing for stage 1
            if (stageNum === 1) stages[1] = { ...stages[1], mode: null, poConfirmed: false };
            let newStatus = order.status;
            if (order.status === 'ready') newStatus = 'sampling_in_progress';
            await supabase.from('sample_orders').update({ production_workflow: stages, status: newStatus }).eq('order_id', oId);
            const { text, keyboard } = await getWorkflowHub(supabase, oId);
            if (keyboard) await editTelegram(chatId, msgId, `✅ <b>Stage ${stageNum} reset.</b> All subsequent stages cleared.\n\n` + text, keyboard);
        }
      }
      else if (data.startsWith("dispatch_prompt_")) {
        const oId = data.replace("dispatch_prompt_", "");
        const prompt = `🚚 <b>Dispatching Order:</b> <code>${oId}</code>\n\nReply with:\n<code>Tracking # | Courier | DD-MM-YYYY</code>\n\nOr type <b>cancel</b>`;
        await sendTelegram(chatId, prompt, { force_reply: true, reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `view_${oId}` }]] } });
      }
      else if (data.startsWith("attach_")) {
        const [_, orderId, mediaId] = data.split("_");
        const mediaMsg = cb.message.reply_to_message;
        if (!mediaMsg || mediaMsg.message_id.toString() !== mediaId) { await sendTelegram(chatId, "⚠️ <b>Context lost.</b> Please reply again."); return NextResponse.json({ ok: true }); }
        const mediaDate = new Date(mediaMsg.date * 1000).toISOString();
        let fileId = mediaMsg.photo ? mediaMsg.photo[mediaMsg.photo.length - 1].file_id : (mediaMsg.video ? mediaMsg.video.file_id : mediaMsg.document?.file_id);
        if (fileId) {
            await supabase.from('order_media').insert([{ order_id: orderId, file_id: fileId, file_type: 'media', created_at: mediaDate }]);
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', orderId).single();
            if (order) {
                const wf = order.production_workflow || {};
                for (let i = 1; i <= 5; i++) { if (!wf[i] || (wf[i].status !== 'completed' && wf[i].status !== 'na')) { wf[i] = { ...(wf[i] || { assignedDays: 7 }), status: 'completed', actualDate: mediaDate, startDate: wf[i]?.startDate || mediaDate }; } }
                await supabase.from('sample_orders').update({ production_workflow: wf, status: 'ready' }).eq('order_id', orderId);
                await editTelegram(chatId, msgId, `✅ <b>Media Tagged to ${orderId}</b>\n🏁 Status updated to: <b>READY</b>`);
            }
        }
      }
      return NextResponse.json({ ok: true });
    }

    const message = body.message;
    if (!message) return NextResponse.json({ ok: true });
    const userId = message.from.id.toString();
    const chatId = message.chat.id.toString();

    if (userId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

    if (message.text) {
      const text = message.text;
      const { data: session } = await supabase.from('tagging_sessions').select('*').eq('user_id', userId).single();

      // --- 1. NEW: TECHNICAL MAPPING COMMAND (/map) ---
      if (text.startsWith("/map")) {
        if (!session) {
          await sendTelegram(chatId, "⚠️ No active technical session. Start one with /sample_approved");
          return NextResponse.json({ ok: true });
        }
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg || !(mediaMsg.photo || mediaMsg.video || mediaMsg.document)) {
          await sendTelegram(chatId, "❌ Please <b>REPLY</b> to a photo with <code>/map</code> to assign it.");
          return NextResponse.json({ ok: true });
        }
        // Fixed Call: Passing keyboard and replyId separately
        await sendTelegram(chatId, `📍 <b>Mapping Style: ${session.style_name}</b>\nWhich measurement is this photo for?`, generateMeasurementKeyboard(session), mediaMsg.message_id);
        return NextResponse.json({ ok: true });
      }

      // --- 2. SESSION STYLE NAME INPUT ---
   
      if (session && session.current_field === "WAITING_FOR_STYLE_NAME") {
        if (text.toLowerCase() === 'cancel') {
          await supabase.from('tagging_sessions').delete().eq('user_id', userId);
          await sendTelegram(chatId, "❌ Session cancelled.");
        // REPLACE WITH:
        } else {
          const fields = await getMeasurementTemplate(supabase, session.garment_type);
          await supabase.from('debug_log').insert([{ context: 'style_name_input', payload: { 
            client_name: session.client_name, 
            dropbox_order_id: session.dropbox_order_id,
            temp_entry_id: session.temp_entry_id,
            order_id: session.order_id,
            session_type: session.session_type,
            style_name_entered: text
          }}]);
          await ensureTaggingFolders(
            session.session_type,
            session.client_name || session.client_id,
            session.dropbox_order_id || session.order_id || session.temp_entry_id,
            text
          );
          await supabase.from('tagging_sessions').update({ style_name: text, current_field: "READY_FOR_MEDIA", remaining_fields: fields }).eq('user_id', userId);
          await sendTelegram(chatId, `📸 <b>Session Started: ${text}</b>\n\n📁 Dropbox folders ready.\nReply to any tech photo with <code>/map</code> to begin.`);
        }
        return NextResponse.json({ ok: true });
      }

      // --- 3. CORE COMMANDS ---
      if (text === "/sample_approved") { await sendTelegram(chatId, "🛠 <b>Sample Approval</b>", { inline_keyboard: [[{ text: "🚀 Start", callback_data: "ts_init_sample" }]] }); return NextResponse.json({ ok: true }); }
      if (text === "/production_piece") { await sendTelegram(chatId, "🏭 <b>Production Tagging</b>", { inline_keyboard: [[{ text: "🚀 Start", callback_data: "ts_init_production" }]] }); return NextResponse.json({ ok: true }); }
      
      if (text.startsWith("/pending")) {
        const { data: orders } = await supabase.from('sample_orders').select('order_id, production_workflow, client:clients(name)').not('status', 'eq', 'dispatched');
        let resp = "⏳ <b>Pending Tasks</b>\n\n";
        (orders || []).forEach((o: any) => {
            const wf = o.production_workflow || {};
            const actId = Object.keys(wf).find(k => wf[k].status === 'in_progress');
            if (actId) {
                const s = wf[actId];
                const due = new Date(new Date(s.startDate).getTime() + (s.assignedDays || 0) * 86400000);
                const diff = Math.ceil((due.getTime() - new Date().getTime()) / 86400000);
                resp += `👤 <b>${o.client?.name || 'N/A'}</b>\n📦 ${o.order_id} | ${diff >= 0 ? diff + 'd left' : '⚠️ ' + Math.abs(diff) + 'd overdue'}\n\n`;
            }
        });
        await sendTelegram(chatId, resp || "✅ No pending tasks.");
        return NextResponse.json({ ok: true });
      }

      // --- 4. REPLY HANDLERS (Dispatch & Budget) ---
      if (message.reply_to_message?.text?.startsWith('🚚 Dispatching Order:')) {
        const oId = message.reply_to_message.text.match(/(TG-\d+|ORD-\d+|FAC-\d+|TASK-\d+)/)?.[0];
        if (text.toLowerCase() === 'cancel') { await sendTelegram(chatId, "❌ Dispatch cancelled."); return NextResponse.json({ ok: true }); }
        const parts = text.split('|').map((p: string) => p.trim());
        if (parts.length >= 3) {
            const [tracking, courier, dateStr] = parts; const [d, m, y] = dateStr.split('-');
            await supabase.from('sample_orders').update({ status: 'dispatched', courier_name: courier, tracking_number: tracking, dispatched_at: new Date(`${y}-${m}-${d}`).toISOString() }).eq('order_id', oId);
            await sendTelegram(chatId, `✅ <b>Order ${oId} Dispatched</b>`);
        } else { await sendTelegram(chatId, "⚠️ Use: Tracking | Courier | DD-MM-YYYY", { force_reply: true }); }
        return NextResponse.json({ ok: true });
      }

      // REPLACE WITH:
      if (message.reply_to_message?.text?.includes('Set Budget (Days)')) {
        const oId = message.reply_to_message.text.match(/(TG-\d+|ORD-\d+|FAC-\d+|TASK-\d+)/)?.[0];
        const sName = message.reply_to_message.text.match(/for (.*)\n/)?.[1];
        const sId = Object.keys(STAGE_NAMES).find(key => STAGE_NAMES[parseInt(key)] === sName);
        if (oId && sId) {
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
            if (order) { const wf = order.production_workflow || {}; wf[sId] = { ...(wf[sId] || {}), assignedDays: parseInt(text) || 0 }; await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', oId); await sendTelegram(chatId, `✅ Budget set to ${text} days.`); }
        }
        return NextResponse.json({ ok: true });
      }

      if (message.reply_to_message?.text?.includes('Set Start Date') || message.reply_to_message?.text?.includes('Set Completion Date')) {
        const replyText = message.reply_to_message.text;
        const oId = replyText.match(/(TG-\d+|ORD-\d+|FAC-\d+|TASK-\d+)/)?.[0];
        const sName = replyText.match(/for (.*)\n/)?.[1];
        const sId = Object.keys(STAGE_NAMES).find(key => STAGE_NAMES[parseInt(key)] === sName);
        const isStart = replyText.includes('Set Start Date');
        if (oId && sId) {
            // Parse DD-MM-YYYY, fallback to today
            let parsedDate: Date;
            const match = text.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (match) {
                const [_, d, m, y] = match;
                parsedDate = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
            } else {
                parsedDate = new Date();
                parsedDate.setUTCHours(0, 0, 0, 0);
            }
            if (isNaN(parsedDate.getTime())) { await sendTelegram(chatId, "⚠️ Invalid date. Use DD-MM-YYYY."); return NextResponse.json({ ok: true }); }
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
            if (order) {
                const wf = order.production_workflow || {};
                if (isStart) {
                    wf[sId] = { ...(wf[sId] || {}), startDate: parsedDate.toISOString() };
                } else {
                    wf[sId] = { ...(wf[sId] || {}), actualDate: parsedDate.toISOString(), status: 'completed' };
                }
                await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', oId);
                const label = isStart ? 'Start Date' : 'Completion Date';
                await sendTelegram(chatId, `✅ <b>${label} set to ${parsedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>`);
            }
        }
        return NextResponse.json({ ok: true });
      }

      // --- STANDALONE TASK: details reply handler ---
      if (message.reply_to_message?.text?.includes('[STASK:')) {
        const replyText = message.reply_to_message.text;
        if (text.toLowerCase() === 'cancel') {
          await sendTelegram(chatId, "❌ Cancelled."); return NextResponse.json({ ok: true });
        }
        const tokenMatch = replyText.match(/\[STASK:([A-Za-z0-9+/]+)\]/);
        let mediaDate = new Date().toISOString();
        let fileId: string | null = null;
        let prefillDesc: string = '';
        if (tokenMatch) {
          try {
            const decoded = JSON.parse(Buffer.from(tokenMatch[1], 'base64').toString('utf8'));
            mediaDate = decoded.mediaDate || mediaDate;
            fileId = decoded.fileId || null;
            prefillDesc = decoded.taskDesc || '';
          } catch {}
        }

        // Detect format: if task desc is pre-filled from text message, user only enters "Name, Days" or "Name"
        // Otherwise full pipe format: "Name | Task | Days"
        let assignedTo = '';
        let taskDescription = prefillDesc;
        let budgetDays: number | null = null;

        if (prefillDesc) {
          // Short format: "Ayush, 3" or "Ayush" or "Ayush | 3"
          const sep = text.includes('|') ? '|' : ',';
          const parts = text.split(sep).map((p: string) => p.trim());
          assignedTo = parts[0];
          const maybeNum = parts[1] ? parseInt(parts[1]) : NaN;
          budgetDays = !isNaN(maybeNum) ? maybeNum : null;
          if (!assignedTo) {
            await sendTelegram(chatId, `⚠️ Just enter the name:\n<code>Ayush</code> or <code>Ayush, 3</code>`, { force_reply: true });
            return NextResponse.json({ ok: true });
          }
        } else {
          // Full pipe format: "Name | Task | Days"
          const parts = text.split('|').map((p: string) => p.trim());
          if (parts.length < 2 || !parts[0] || !parts[1]) {
            await sendTelegram(chatId, `⚠️ Use format:\n<code>Assigned To | Nature of Task</code>\nor with deadline:\n<code>Assigned To | Nature of Task | Budget Days</code>`, { force_reply: true });
            return NextResponse.json({ ok: true });
          }
          assignedTo = parts[0];
          taskDescription = parts[1];
          budgetDays = (parts[2] && !isNaN(parseInt(parts[2]))) ? parseInt(parts[2]) : null;
        }

        const completionDate = budgetDays !== null
          ? new Date(new Date(mediaDate).getTime() + budgetDays * 86400000).toISOString()
          : null;
        const taskId = `TASK-${Math.floor(1000 + Math.random() * 9000)}`;
        await supabase.from('tasks').insert([{
          task_id: taskId, is_standalone: true, status: 'pending',
          start_date: mediaDate, start_file_id: fileId || null,
          title: taskDescription, assigned_to: assignedTo,
          description: taskDescription, budget_days: budgetDays,
          completion_date: completionDate
        }]);
        const startDisplay = new Date(mediaDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const dueDisplay = completionDate ? new Date(completionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';
        await sendTelegram(chatId,
          `✅ <b>Task Created</b>\n🆔 <code>${taskId}</code>\n👤 <b>${assignedTo}</b>\n📋 <b>${taskDescription}</b>\n📅 Start: ${startDisplay}\n🏁 Due: ${dueDisplay}`,
          { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "menu_main" }]] }
        );
        return NextResponse.json({ ok: true });
      }
      // --- TASK: manual completion date reply handler ---
      if (message.reply_to_message?.text?.includes('[TASK_COMPDATE:')) {
        const replyText = message.reply_to_message.text;
        const match = replyText.match(/\[TASK_COMPDATE:(TASK-\d+)\]/);
        if (!match) return NextResponse.json({ ok: true });
        const taskId = match[1];
        const dateMatch = text.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (!dateMatch) { await sendTelegram(chatId, `⚠️ Use DD-MM-YYYY format.`, { force_reply: true }); return NextResponse.json({ ok: true }); }
        const [_, d, m, y] = dateMatch;
        const completionDate = new Date(`${y}-${m}-${d}T00:00:00.000Z`).toISOString();
        const { data: task } = await supabase.from('tasks').select('*').eq('task_id', taskId).single();
        if (task) {
          await supabase.from('tasks').update({ status: 'completed', completion_date: completionDate }).eq('task_id', taskId);
          if (task.order_id && task.stage_id) {
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', task.order_id).single();
            if (order) {
              const wf = order.production_workflow || {};
              wf[task.stage_id] = { ...wf[task.stage_id], status: 'completed', actualDate: completionDate };
              await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', task.order_id);
            }
          }
          await sendTelegram(chatId,
            `✅ <b>Task Completed!</b>\n🆔 <code>${taskId}</code>\n👤 ${task.assigned_to || ''}\n📋 ${task.description || task.title || ''}\n📅 Done: ${new Date(completionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- STANDALONE TASK: manual date reply handler ---
      if (message.reply_to_message?.text?.includes('[STASK_DATE:')) {
        const replyText = message.reply_to_message.text;
        const dateMatch = replyText.match(/\[STASK_DATE:(TASK-\d+)_(start|end)\]/);
        if (!dateMatch) return NextResponse.json({ ok: true });
        const [, taskId, dateType] = dateMatch;
        const match = text.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (!match) {
          await sendTelegram(chatId, `⚠️ Invalid format. Use DD-MM-YYYY.`, { force_reply: true });
          return NextResponse.json({ ok: true });
        }
        const [_, d, m, y] = match;
        const parsedDate = new Date(`${y}-${m}-${d}T00:00:00.000Z`).toISOString();
        const updatePayload: any = dateType === 'start'
          ? { start_date: parsedDate }
          : { completion_date: parsedDate };
        await supabase.from('tasks').update(updatePayload).eq('task_id', taskId);
        const label = dateType === 'start' ? 'Start Date' : 'Due Date';
        await sendTelegram(chatId, `✅ <b>${label} updated</b> for <code>${taskId}</code>\n📅 ${new Date(parsedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`);
        return NextResponse.json({ ok: true });
      }

      // --- 5. WORKFLOW HANDLERS ---
      if (text.startsWith("/assign") || text.startsWith("/task")) {
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg) { await sendTelegram(chatId, "❌ Reply to a photo, video, or text message with /assign to create a task."); return NextResponse.json({ ok: true }); }
        const mediaDate = new Date(mediaMsg.date * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const keyboard = { inline_keyboard: [
          [{ text: "🆕 Standalone Task", callback_data: `asgn_mode_${mediaMsg.message_id}_standalone` }],
          [{ text: "🔗 Link to Client & Order", callback_data: `asgn_mode_${mediaMsg.message_id}_associate` }]
        ]};
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: `🛠 <b>Create Task</b>\n📅 Start date will be: <b>${mediaDate}</b>`, parse_mode: 'HTML', reply_to_message_id: mediaMsg.message_id, reply_markup: keyboard });
      } else if (text.startsWith("/complete")) {
        const mediaMsg = message.reply_to_message;
        // mediaTs = unix timestamp of the replied-to message (0 if no reply)
        const mediaTs = mediaMsg ? mediaMsg.date : 0;
        const { data: tasks } = await supabase.from('tasks').select('*').eq('status', 'pending').order('created_at', { ascending: false });
        if (!tasks || tasks.length === 0) { await sendTelegram(chatId, "✅ No pending tasks found."); return NextResponse.json({ ok: true }); }
        const buttons = tasks.map((t: any) => ([{
          text: t.is_standalone
            ? `🆕 ${t.assigned_to || 'N/A'} | ${(t.description || t.title || t.task_id).substring(0, 35)}`
            : `📦 ${t.order_id} | ${t.stage_name}`,
          callback_data: `task_view_${t.task_id}_ts_${mediaTs}`
        }]));
        const headerText = mediaMsg
          ? `🏁 <b>Select task to complete:</b>\n📎 Media date: <b>${new Date(mediaTs * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>`
          : `🏁 <b>Select task to complete:</b>`;
        await sendTelegram(chatId, headerText, { inline_keyboard: buttons });
      }
      else if (text.startsWith("/tag")) {
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg) return NextResponse.json({ ok: true });
        const { data: orders } = await supabase.from('sample_orders').select('order_id, client:clients(name)').not('status', 'eq', 'dispatched').order('created_at', { ascending: false }).limit(10);
        const buttons = (orders || []).map((o: any) => ([{ text: `${o.order_id} | ${o.client?.name || 'Client'}`, callback_data: `attach_${o.order_id}_${mediaMsg.message_id}` }]));
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: "📎 <b>Tag to:</b>", parse_mode: 'HTML', reply_to_message_id: mediaMsg.message_id, reply_markup: { inline_keyboard: buttons } });
      }
      else if (text === "/start" || text.toLowerCase() === "menu") {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "⏳ Pending Tasks", callback_data: "menu_pending" }]] };
        await sendTelegram(chatId, "👋 <b>Admin Dashboard</b>", mainKeyboard);
      }
    }

    // --- FINAL EXCEL IMPORT HANDLER ---
    if (message.document && message.document.file_name?.endsWith('.xlsx')) {
        const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${message.document.file_id}`);
        const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
        const workbook = XLSX.read(response.data, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        if (!rows || rows.length === 0) {
            await sendTelegram(chatId, `⚠️ <b>Excel Import Failed</b>\n\nThe file appears to be empty or unreadable.`);
        } else if (!rows[0]?.client_email) {
            await sendTelegram(chatId, `⚠️ <b>Excel Import Failed</b>\n\nMissing required field: <code>client_email</code>\n\nRequired columns: <code>client_email</code>, <code>client_name</code>, <code>style_name</code>, <code>quantity</code>`);
        } else {
            let { data: client } = await supabase.from('clients').select('id, name').eq('email', rows[0].client_email).eq('is_deleted', false).single();
            const isNewClient = !client;
            if (!client) {
    // Check if client exists but is deleted — restore instead of inserting
    const { data: deleted } = await supabase.from('clients').select('id, name').eq('email', rows[0].client_email).single();
    if (deleted) {
        // Restore deleted client
        const { data: restored } = await supabase.from('clients')
            .update({ is_deleted: false, name: rows[0].client_name })
            .eq('id', deleted.id).select().single();
        client = restored;
    } else {
        // Truly new client
        const { data: nc, error: clientErr } = await supabase.from('clients')
            .insert([{ name: rows[0].client_name, email: rows[0].client_email }])
            .select().single();
        if (clientErr || !nc) {
            await sendTelegram(chatId, `❌ <b>Failed to create client</b>\n\n<code>${clientErr?.message || 'Unknown error'}</code>`);
            return NextResponse.json({ ok: true });
        }
        client = nc;
    }
}
            const orderId = `TG-${Math.floor(1000 + Math.random() * 9000)}`;
            const initialWF = {
  1: { status: 'pending', assignedDays: 0 },
  2: { status: 'pending', assignedDays: 0 },
  3: { status: 'pending', assignedDays: 0 },
  4: { status: 'pending', assignedDays: 0 },
  5: { status: 'pending', assignedDays: 0 },
};
            const { data: order, error: orderErr } = await supabase.from('sample_orders').insert([{ client_id: client?.id, order_id: orderId, status: 'submitted', production_workflow: initialWF, created_by: 'automation' }]).select().single();
            if (orderErr || !order) {
                await sendTelegram(chatId, `❌ <b>Order creation failed</b>\n\n<code>${orderErr?.message || 'Unknown error'}</code>`);
            } else {
                const styles = rows.filter((r: any) => r.style_name);
                const { error: stylesErr } = await supabase.from('order_styles').insert(styles.map((r: any) => ({
  order_id: order.id,
  style_name: r.style_name || 'Unnamed Style',
  quantity: r.quantity ? parseInt(r.quantity) : 1,
  item_number: r.item_number || r.style_number || `ITEM-${Math.floor(1000 + Math.random() * 9000)}`,
  style_number: r.style_number || null,
  print_type: r.print_type === 'printed' ? 'printed' : 'solid_dyed',
  color_name: r.color_name || null,
  pantone_number: r.pantone_number || null,
  design_name: r.design_name || null,
  fabric: r.fabric || null,
  notes: r.notes || null,
})));
if (stylesErr) console.error('Styles insert error:', stylesErr.message);
                const styleLines = styles.map((r: any) => `  • ${r.style_name} — ${r.quantity || 'N/A'} pcs`).join('\n');
                const clientLabel = client?.name || rows[0].client_name || rows[0].client_email;
                await sendTelegram(chatId,
                    `✅ <b>Order Created via Excel</b>\n\n🆔 Order ID: <code>${orderId}</code>\n👤 Client: <b>${clientLabel}</b>${isNewClient ? ' <i>(new)</i>' : ''}\n📧 ${rows[0].client_email}\n\n👕 <b>${styles.length} Style(s):</b>\n${styleLines || '  • No styles found'}\n\n📌 Status: <code>SUBMITTED</code>\n🏗 Stage: Pattern & Sampling started`,
                    { inline_keyboard: [[{ text: "📋 View Order", callback_data: `view_${orderId}` }, { text: "🏠 Menu", callback_data: "menu_main" }]] }
                );
            }
        }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) { console.error('Bot Error:', err); return NextResponse.json({ ok: true }); }
}