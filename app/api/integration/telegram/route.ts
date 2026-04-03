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
const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

async function dbxEnsureFolder(path: string) {
  try {
    await axios.post('https://api.dropboxapi.com/2/files/create_folder_v2',
      { path, autorename: false },
      { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    // 409 = folder already exists — that's fine, ignore
    if (err.response?.status !== 409) {
      console.error('Dropbox folder error:', path, err.response?.data || err.message);
    }
  }
}

async function dbxUploadFile(dropboxPath: string, fileBuffer: Buffer) {
  try {
    await axios.post('https://content.dropboxapi.com/2/files/upload',
      fileBuffer,
      {
        headers: {
          Authorization: `Bearer ${DROPBOX_TOKEN}`,
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
  const { data: orders } = await supabase.from('sample_orders').select('order_id, status, client:clients(name)').not('status', 'eq', 'dispatched').order('created_at', { ascending: false }).limit(15);
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

      // --- 2. ASSIGNMENT & WATERFALL ---
      else if (data.startsWith("asgn_mode_")) {
        const [_, __, mediaId, mode] = data.split("_");
        if (mode === "standalone") {
            const orderId = `TASK-${Math.floor(1000 + Math.random() * 9000)}`;
            let { data: client } = await supabase.from('clients').select('id').eq('name', 'Internal Factory').single();
            if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: 'Internal Factory', email: `factory_${Date.now()}@internal.com` }]).select().single(); client = nc; }
            const now = new Date().toISOString();
            const initialWF = { 
              1: { status: 'completed', assignedDays: 0, startDate: now, actualDate: now },
              2: { status: 'completed', assignedDays: 0, startDate: now, actualDate: now },
              3: { status: 'completed', assignedDays: 0, startDate: now, actualDate: now },
              4: { status: 'completed', assignedDays: 0, startDate: now, actualDate: now },
              5: { status: 'in_progress', assignedDays: 0, startDate: now } 
            };
            await supabase.from('sample_orders').insert([{ client_id: client?.id, order_id: orderId, status: 'sampling_in_progress', production_workflow: initialWF }]);
            await editTelegram(chatId, msgId, `✅ <b>Task Created: ${orderId}</b>\n🔬 Stage 5 started.\n\n🔢 Please set the budget below:`);
            await sendTelegram(chatId, `🔢 <b>Set Budget (Days) for ${STAGE_NAMES[5]}</b>\nID: <code>${orderId}</code>\n\nReply with a number (e.g. 7)`, { force_reply: true });
        } else {
            const { keyboard } = await getOrderList(supabase);
            const orderButtons = (keyboard?.inline_keyboard || []).filter((row: any) => row[0].callback_data.startsWith('view_'));
            const newKeyboard = { inline_keyboard: orderButtons.map((row: any) => ([{ text: row[0].text, callback_data: `asgn_ord_${mediaId}_${row[0].callback_data.replace('view_', '')}` }])) };
            await editTelegram(chatId, msgId, "🎯 <b>Select Order to Link:</b>", newKeyboard);
        }
      }
      else if (data.startsWith("asgn_ord_")) {
        const [_, __, mediaId, orderId] = data.split("_");
        const stageButtons = [1, 2, 3, 4, 5].map(i => ([{ text: `${i}. ${STAGE_NAMES[i]}`, callback_data: `asgn_stg_${mediaId}_${orderId}_${i}` }]));
        await editTelegram(chatId, msgId, `🏗 <b>Stage Selection: ${orderId}</b>\nWhich stage starts with this media?`, { inline_keyboard: stageButtons });
      }
      else if (data.startsWith("asgn_stg_")) {
        const [_, __, mediaId, orderId, stageId] = data.split("_");
        const sNum = parseInt(stageId);
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', orderId).single();
        if (order) {
            const wf = order.production_workflow || {};
            const now = new Date().toISOString();
            // WATERFALL: Auto-complete all previous stages
            for (let i = 1; i < sNum; i++) {
                if (!wf[i] || (wf[i].status !== 'completed' && wf[i].status !== 'na')) {
                    wf[i] = { ...(wf[i] || { assignedDays: 0 }), status: 'completed', actualDate: now, startDate: wf[i]?.startDate || now };
                }
            }
            const currentBudget = wf[sNum]?.assignedDays || 0;
            wf[sNum] = { ...(wf[sNum] || { assignedDays: 0 }), status: 'in_progress', startDate: now };
            await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', orderId);
            
            if (currentBudget === 0) {
                await editTelegram(chatId, msgId, `✅ <b>Success!</b>\nOrder: ${orderId}\nStage: ${STAGE_NAMES[sNum]} started.\n\n🔢 Please set the budget below:`);
                await sendTelegram(chatId, `🔢 <b>Set Budget (Days) for ${STAGE_NAMES[sNum]}</b>\nID: <code>${orderId}</code>\n\nReply with a number (e.g. 5)`, { force_reply: true });
            } else {
                await editTelegram(chatId, msgId, `✅ <b>Success!</b>\nOrder: ${orderId}\nStage: ${STAGE_NAMES[sNum]} started.`);
            }
        }
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
      else if (data === "menu_pending") {
        const { data: orders } = await supabase.from('sample_orders').select('order_id, production_workflow, client:clients(name)').not('status', 'eq', 'dispatched');
        let response = "⏳ <b>Pending Tasks</b>\n\n";
        (orders || []).forEach((o: any) => {
            const wf = o.production_workflow || {};
            const actId = Object.keys(wf).find(k => wf[k].status === 'in_progress');
            if (actId) {
                const s = wf[actId];
                const budget = s.assignedDays || 0;
                const due = new Date(new Date(s.startDate).getTime() + budget * 86400000);
                const diff = Math.ceil((due.getTime() - new Date().getTime()) / 86400000);
                response += `👤 ${o.client?.name || 'N/A'} | <code>${o.order_id}</code>\n📍 ${STAGE_NAMES[parseInt(actId)]} | ${diff >= 0 ? diff + 'd left' : '⚠️ ' + Math.abs(diff) + 'd overdue'}\n\n`;
            }
        });
        await editTelegram(chatId, msgId, response || "✅ No pending tasks.", { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_main" }]] });
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

      // --- 5. WORKFLOW HANDLERS ---
      if (text.startsWith("/assign") || text.startsWith("/task")) {
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg) { await sendTelegram(chatId, "❌ Reply to media with /assign"); return NextResponse.json({ ok: true }); }
        const keyboard = { inline_keyboard: [[{ text: "🆕 Standalone Task", callback_data: `asgn_mode_${mediaMsg.message_id}_standalone` }], [{ text: "🔗 Associate to Order", callback_data: `asgn_mode_${mediaMsg.message_id}_associate` }]] };
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: "🛠 <b>Assignment</b>", parse_mode: 'HTML', reply_to_message_id: mediaMsg.message_id, reply_markup: keyboard });
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
        const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[0]);
        if (rows[0]?.client_email) {
            let { data: client } = await supabase.from('clients').select('id').eq('email', rows[0].client_email).single();
            if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: rows[0].client_name, email: rows[0].client_email }]).select().single(); client = nc; }
            const initialWF = { 5: { status: 'in_progress', assignedDays: 7, startDate: new Date().toISOString() } };
            const { data: order } = await supabase.from('sample_orders').insert([{ client_id: client?.id, order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`, status: 'submitted', production_workflow: initialWF }]).select().single();
            if (order) { await supabase.from('order_styles').insert(rows.map((r: any) => ({ order_id: order.id, style_name: r.style_name, quantity: r.quantity }))); await sendTelegram(chatId, `✅ <b>Order Imported via Excel.</b>`); }
        }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) { console.error('Bot Error:', err); return NextResponse.json({ ok: true }); }
}