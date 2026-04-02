import { createClient as createSupabaseDirect } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import axios from 'axios';

export const dynamic = 'force-dynamic';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000;

// --- AXIOS RESILIENCE WRAPPER ---
const botAxios = axios.create({ timeout: 8000 });
async function retryAxios(fn: () => Promise<any>, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) { if (i === retries) throw err; }
  }
}

// --- STRUCTURED LOGGING ---
function logAction(userId: string, action: string, status: 'SUCCESS' | 'ERROR' | 'INFO', metadata: any = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), userId, action, status, ...metadata }));
}

// --- GLOBAL SUPABASE ERROR HANDLER ---
async function safeQuery<T = any>(
  supabasePromise: PromiseLike<{ data: T; error: any }>,
  userId: string,
  action: string,
  orderId?: string
): Promise<T> {
  try {
    const res = await supabasePromise;
    if (!res) throw new Error("No response from Supabase");
    if (res.error) throw res.error;
    logAction(userId, action, 'SUCCESS', { orderId });
    return res.data;
  } catch (err: any) {
    logAction(userId, action, 'ERROR', { orderId, error: err.message });
    throw err;
  }
}

// --- TELEGRAM HELPERS ---
async function sendTelegram(chatId: string, text: string, replyMarkup?: any, replyToId?: number) {
  try {
    await retryAxios(() => botAxios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup, reply_to_message_id: replyToId
    }));
  } catch (err: any) { console.error('TG Send Error:', err.response?.data || err.message); }
}

async function editTelegram(chatId: string, messageId: number, text: string, replyMarkup?: any) {
  try {
    await retryAxios(() => botAxios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: replyMarkup
    }));
  } catch (err: any) { 
    if (!err.response?.data?.description?.includes("message is not modified")) {
      console.error('TG Edit Error:', err.response?.data || err.message); 
    }
  }
}

async function answerCallback(callbackQueryId: string, text?: string) {
  try {
    await botAxios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId, text: text || undefined
    });
  } catch (err: any) { console.error('Callback Answer Error:', err.message); }
}

// --- UTILS & VALIDATORS ---
const STAGE_NAMES: Record<number, string> = {
  1: "Fabric Procurement", 2: "Dyeing Stage", 3: "Printing Stage", 4: "Embroidery Stage", 5: "Pattern & Sampling"
};

function validateWF(wf: any) {
  const base = { ...wf };
  for (let i = 1; i <= 5; i++) {
    if (!base[i]) base[i] = { status: 'pending', assignedDays: 0, startDate: null, actualDate: null };
  }
  return base;
}

function parseDateInput(text: string) {
  const clean = text.trim().replace(/\s+/g, '');
  const parts = clean.split('-');
  if (parts.length !== 3) return null;
  const d = parseInt(parts[0]), m = parseInt(parts[1]) - 1, y = parseInt(parts[2]);
  const date = new Date(y, m, d);
  return (isNaN(date.getTime()) || y < 2024 || y > 2030) ? null : date.toISOString();
}

function sanitizeInput(text: string, limit = 100) {
  if (!text) return "";
  return text.replace(/<\/?[^>]+(>|$)/g, "").trim().substring(0, limit);
}

// --- UI GENERATORS ---
async function getWorkflowHub(supabase: any, orderId: string, userId: string) {
  const order = await safeQuery(supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single(), userId, 'FETCH_WF', orderId);
  const stages = validateWF(order.production_workflow || {});
  let text = `⚙️ <b>Workflow: ${orderId}</b>\n\n`;
  const buttons = [];
  for (let i = 1; i <= 5; i++) {
    const s = stages[i];
    const icon = s.status === 'completed' ? '✅' : (s.status === 'in_progress' ? '🔵' : '🕒');
    const spent = s.startDate ? Math.max(0, Math.floor((( (s.actualDate ? new Date(s.actualDate).getTime() : new Date().getTime()) - new Date(s.startDate).getTime()) / 86400000))) : 0;
    text += `${icon} <b>${STAGE_NAMES[i]}</b>\n   Status: <i>${s.status}</i> | Time: ${spent}/${s.assignedDays}d\n\n`;
    buttons.push([{ text: `${icon} Manage ${STAGE_NAMES[i]}`, callback_data: `wf_stage_${orderId}_${i}` }]);
  }
  buttons.push([{ text: "⬅️ Back", callback_data: `view_${orderId}` }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

async function getStageDetail(supabase: any, orderId: string, stageId: number, userId: string) {
  const order = await safeQuery(supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single(), userId, 'FETCH_STAGE', orderId);
  const s = validateWF(order.production_workflow || {})[stageId];
  let text = `🏗️ <b>${STAGE_NAMES[stageId]}</b>\nID: <code>${orderId}</code>\n\n📌 Status: <b>${s.status.toUpperCase()}</b>\n📅 Start: ${s.startDate ? new Date(s.startDate).toLocaleDateString('en-GB') : '---'}\n🏁 Finished: ${s.actualDate ? new Date(s.actualDate).toLocaleDateString('en-GB') : '---'}\n⏱ Budget: ${s.assignedDays} Days`;
  return { text, keyboard: { inline_keyboard: [
    [{ text: "📅 Edit Start Date", callback_data: `wf_prompt_start_${orderId}_${stageId}` }],
    [{ text: "✅ Done (Today)", callback_data: `wf_update_${orderId}_${stageId}_completed` }],
    [{ text: "📝 Done (Manual Date)", callback_data: `wf_prompt_comp_${orderId}_${stageId}` }],
    [{ text: "⏳ Set Budget", callback_data: `wf_prompt_budget_${orderId}_${stageId}` }],
    [{ text: "🔄 Reset Stage", callback_data: `wf_reset_${orderId}_${stageId}` }],
    [{ text: "⬅️ Back", callback_data: `wf_hub_${orderId}` }]
  ] } };
}

// --- MAIN ROUTE ---
export async function POST(request: Request) {
  const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || "";
  const supabase = createSupabaseDirect(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  
  try {
    const body = await request.json();
    if (body.callback_query) {
      const cb = body.callback_query;
      const adminId = cb.from.id.toString();
      const chatId = cb.message.chat.id.toString();
      const msgId = cb.message.message_id;
      const data = sanitizeInput(cb.data || "", 150);

      if (adminId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

      // CALLBACK IDEMPOTENCY
      const { data: existingCb } = await supabase.from('tg_callback_logs').select('id').eq('id', cb.id).maybeSingle();
      if (existingCb) return NextResponse.json({ ok: true });
      
      // Standard try/catch to handle uniqueness violations or network errors
      try {
        await supabase.from('tg_callback_logs').insert([{ id: cb.id }]);
      } catch (e) {
        logAction(adminId, 'CALLBACK_IDEMPOTENCY_ERR', 'INFO', { msg: 'Duplicate or failed log' });
      }
      if (data.startsWith("ts_init_")) {
        const clients = await safeQuery(supabase.from('clients').select('id, name'), adminId, 'INIT_TAGGING');
        const buttons = (clients || []).map((c: any) => ([{ text: c.name, callback_data: `ts_cl_${data.replace("ts_init_", "")}_${c.id}` }]));
        await editTelegram(chatId, msgId, "👤 <b>Select Client:</b>", { inline_keyboard: buttons });
      }
      else if (data.startsWith("ts_cl_")) {
        const [_, __, type, clientId] = data.split("_");
        const orders = await safeQuery(supabase.from('sample_orders').select('order_id').eq('client_id', clientId).not('status', 'eq', 'dispatched'), adminId, 'FETCH_ORDERS');
        const buttons = (orders || []).map((o: any) => ([{ text: `Order: ${o.order_id}`, callback_data: `ts_ord_${type}_${clientId}_${o.order_id}` }]));
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
        const styles = await safeQuery(supabase.from('order_styles').select('style_name').eq('order_id', orderId), adminId, 'FETCH_STYLES', orderId);
        const buttons = (styles || []).map((s: any) => ([{ text: s.style_name, callback_data: `ts_style_sel_${type}_${clientId}_${orderId}_${gType}_${s.style_name}` }]));
        buttons.push([{ text: "➕ New Style Name", callback_data: `ts_style_new_${type}_${clientId}_${orderId}_${gType}` }]);
        await editTelegram(chatId, msgId, `👕 <b>Select Style:</b>`, { inline_keyboard: buttons });
      }
      else if (data.startsWith("ts_style_new_")) {
        const [_, __, ___, type, clientId, orderId, gType] = data.split("_");
        await safeQuery(supabase.from('tagging_sessions').delete().eq('user_id', adminId), adminId, 'CLEAN_SESSION');
        await safeQuery(supabase.from('tagging_sessions').insert([{ user_id: adminId, session_type: type, client_id: clientId, order_id: orderId === "NEW" ? null : orderId, garment_type: gType, current_field: "WAITING_FOR_STYLE_NAME" }]), adminId, 'START_SESSION');
        await editTelegram(chatId, msgId, `✍️ <b>Type Style Name now:</b>`);
      }
      else if (data.startsWith("ts_style_sel_")) {
        const [_, __, ___, type, clientId, orderId, gType, styleName] = data.split("_");
        const tmpl = await safeQuery(supabase.from('measurement_templates').select('fields').eq('garment_type', gType).single(), adminId, 'GET_TEMPLATE');
        await safeQuery(supabase.from('tagging_sessions').delete().eq('user_id', adminId), adminId, 'CLEAN_SESSION');
        await safeQuery(supabase.from('tagging_sessions').insert([{ user_id: adminId, session_type: type, client_id: clientId, order_id: orderId === "NEW" ? null : orderId, garment_type: gType, style_name: styleName, current_field: "READY", remaining_fields: tmpl?.fields || [] }]), adminId, 'START_EXISTING');
        await editTelegram(chatId, msgId, `📸 <b>Started: ${styleName}</b>\nReply to image with /map`);
      }
      else if (data.startsWith("ts_set_field_")) {
        const fieldName = data.replace("ts_set_field_", "");
        const s = await safeQuery(supabase.from('tagging_sessions').select('*').eq('user_id', adminId).maybeSingle(), adminId, 'CHECK_SESSION');
        if (!s || (new Date().getTime() - new Date(s.created_at).getTime() > SESSION_EXPIRY_MS)) { await answerCallback(cb.id, "Session expired."); return NextResponse.json({ ok: true }); }
        if (!s.remaining_fields.includes(fieldName)) { await answerCallback(cb.id, "Already saved."); return NextResponse.json({ ok: true }); }
        const media = cb.message.reply_to_message;
        const fileId = media?.photo?.[media.photo.length - 1]?.file_id || media?.video?.file_id || media?.document?.file_id;
        if (!fileId) { await answerCallback(cb.id, "❌ Reply to Photo/Video/Doc!"); return NextResponse.json({ ok: true }); }
        const table = s.session_type === "sample" ? "sample_measurements" : "production_measurements";
        await safeQuery(supabase.from(table).insert([{ client_id: s.client_id, order_id: s.order_id, garment_type: s.garment_type, style_name: s.style_name, measurement_type: fieldName, file_id: fileId }]), adminId, 'SAVE_MEASUREMENT');
        const newRem = s.remaining_fields.filter((f: string) => f !== fieldName);
        await safeQuery(supabase.from('tagging_sessions').update({ remaining_fields: newRem }).eq('user_id', adminId), adminId, 'UPDATE_SESSION');
        await editTelegram(chatId, msgId, `✅ <b>${fieldName} Saved</b>`, { inline_keyboard: (newRem.map((f: string) => ([{ text: f, callback_data: `ts_set_field_${f}` }]))).concat([[{ text: "✅ FINISH", callback_data: "ts_confirm_done" }]]) });
      }
      else if (data === "ts_confirm_done") {
        await safeQuery(supabase.from('tagging_sessions').delete().eq('user_id', adminId), adminId, 'FINALIZE_SESSION');
        await editTelegram(chatId, msgId, "✅ <b>Tagging Completed Successfully.</b>");
      }
      else if (data.startsWith("wf_stage_")) {
        const [_, __, oid, sid] = data.split("_");
        const res = await getStageDetail(supabase, oid, parseInt(sid), adminId);
        await editTelegram(chatId, msgId, res.text, res.keyboard);
      }
      else if (data.startsWith("wf_prompt_")) {
        const [_, __, type, oid, sid] = data.split("_");
        const sName = STAGE_NAMES[parseInt(sid)];
        let text = "";
        if (type === 'budget') text = `⏳ <b>[SET_BUDGET|${oid}|${sid}]</b>\nSet Budget (Days) for ${sName}`;
        else if (type === 'start') text = `📅 <b>[SET_START|${oid}|${sid}]</b>\nSet START Date for ${sName}\nFormat: DD-MM-YYYY`;
        else if (type === 'comp') text = `✅ <b>[SET_COMP|${oid}|${sid}]</b>\nSet COMPLETION Date for ${sName}\nFormat: DD-MM-YYYY`;
        await sendTelegram(chatId, text, { force_reply: true });
      }
      else if (data.startsWith("wf_update_")) {
        const [_, __, oid, sid, status] = data.split("_");
        const sId = parseInt(sid);
        const order = await safeQuery(supabase.from('sample_orders').select('production_workflow').eq('order_id', oid).single(), adminId, 'GET_WF', oid);
        const wf = validateWF(order?.production_workflow || {});
        if (status === 'completed' && sId > 1 && wf[sId - 1].status !== 'completed') {
          await answerCallback(cb.id, `❌ Complete ${STAGE_NAMES[sId - 1]} first!`);
          return NextResponse.json({ ok: true });
        }
        const now = new Date().toISOString();
        wf[sId] = { ...wf[sId], status, actualDate: now };
        if (status === 'completed' && sId < 5) {
          if (wf[sId+1].status !== 'completed') wf[sId+1] = { ...wf[sId+1], status: 'in_progress', startDate: now, assignedDays: wf[sId+1].assignedDays || 7 };
        }
        await safeQuery(supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', oid), adminId, 'COMMIT_WF', oid);
        const res = await getWorkflowHub(supabase, oid, adminId);
        await editTelegram(chatId, msgId, res.text, res.keyboard);
      }
      else if (data.startsWith("wf_reset_")) {
        const [_, __, oid, sid] = data.split("_");
        const order = await safeQuery(supabase.from('sample_orders').select('production_workflow').eq('order_id', oid).single(), adminId, 'RESET_WF', oid);
        const wf = validateWF(order?.production_workflow || {});
        wf[sid] = { status: 'pending', assignedDays: wf[sid].assignedDays || 0, startDate: null, actualDate: null };
        await safeQuery(supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', oid), adminId, 'COMMIT_RESET', oid);
        const res = await getStageDetail(supabase, oid, parseInt(sid), adminId);
        await editTelegram(chatId, msgId, res.text, res.keyboard);
      }
      else if (data === "menu_list") {
        const orders = await safeQuery(supabase.from('sample_orders').select('order_id, status, client:clients(name)').not('status', 'eq', 'dispatched').limit(15), adminId, 'LIST');
        const keyboard = { inline_keyboard: (orders || []).map((o: any) => ([{ text: `${o.order_id} | ${o.client?.name}`, callback_data: `view_${o.order_id}` }])).concat([[{ text: "⬅️ Menu", callback_data: "menu_main" }]]) };
        await editTelegram(chatId, msgId, "📋 <b>Active Orders:</b>", keyboard);
      }
      else if (data.startsWith("view_")) {
        const oid = data.replace("view_", "");
        const order = await safeQuery(supabase.from('sample_orders').select('*, client:clients(name)').eq('order_id', oid).single(), adminId, 'VIEW', oid);
        const styles = await safeQuery(supabase.from('order_styles').select('*').eq('order_id', order.id), adminId, 'STYLES', oid);
        const text = `🔖 <b>ID:</b> <code>${order.order_id}</code>\n👤 <b>Client:</b> ${order.client?.name}\n🏁 <b>Status:</b> ${order.status.toUpperCase()}\n\n👕 <b>Styles:</b>\n` + (styles || []).map((s: any) => `• ${s.style_name}`).join('\n');
        await editTelegram(chatId, msgId, text, { inline_keyboard: [[{ text: "⚙️ HUB", callback_data: `wf_hub_${oid}` }], [{ text: "🚚 DISPATCH", callback_data: `dispatch_prompt_${oid}` }], [{ text: "📋 List", callback_data: "menu_list" }]] });
      }
      else if (data.startsWith("dispatch_prompt_")) {
        const oid = data.replace("dispatch_prompt_", "");
        await sendTelegram(chatId, `🚚 <b>[DISPATCH|${oid}]</b>\nDispatching Order: ${oid}\n\nReply: <code>Tracking | Courier | DD-MM-YYYY</code>`, { force_reply: true });
      }
      await answerCallback(cb.id);
      return NextResponse.json({ ok: true });
    }

    const msg = body.message;
    if (!msg || msg.from.id.toString() !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });
    const chatId = msg.chat.id.toString();

    if (msg.text) {
      const text = sanitizeInput(msg.text || "", 300);
      const reply = msg.reply_to_message?.text || "";
      const { data: s } = await supabase.from('tagging_sessions').select('*').eq('user_id', ALLOWED_USER_ID).maybeSingle();

      if (s?.current_field === "WAITING_FOR_STYLE_NAME") {
        const cleanStyle = sanitizeInput(text, 50);
        // Added fallback || "" to garment_type to satisfy TypeScript
        const tmpl = await safeQuery(
          supabase.from('measurement_templates').select('fields').eq('garment_type', s.garment_type || "").single(), 
          ALLOWED_USER_ID, 
          'SET_STYLE'
        );
        await safeQuery(
          supabase.from('tagging_sessions').update({ style_name: cleanStyle, current_field: "READY", remaining_fields: tmpl?.fields || [] }).eq('user_id', ALLOWED_USER_ID), 
          ALLOWED_USER_ID, 
          'UPDATE_SESSION'
        );
        await sendTelegram(chatId, `📸 <b>Started: ${cleanStyle}</b>\nReply to photo with /map`);
        return NextResponse.json({ ok: true });
      }
      if (text === "/start" || text.toLowerCase() === "menu") {
        await sendTelegram(chatId, "🏠 <b>Admin Hub</b>", { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }], [{ text: "🛠 Sample Audit", callback_data: "ts_init_sample" }, { text: "🏭 Production Audit", callback_data: "ts_init_production" }]] });
      }
      else if (text.startsWith("/map")) {
        if (!s || s.remaining_fields?.length === 0) return sendTelegram(chatId, "❌ No active session.");
        if (!msg.reply_to_message || (!msg.reply_to_message.photo && !msg.reply_to_message.video && !msg.reply_to_message.document)) return sendTelegram(chatId, "❌ Reply to media!");
        await sendTelegram(chatId, `📍 Map: ${s.style_name}`, { inline_keyboard: s.remaining_fields.map((f: string) => ([{ text: f, callback_data: `ts_set_field_${f}` }])) }, msg.reply_to_message.message_id);
      }
      else if (reply.includes("[SET_")) {
        const meta = reply.match(/\[(SET_START|SET_COMP|SET_BUDGET)\|(.+)\|(\d+)\]/);
        if (!meta) return;
        const [_, type, oId, sIdStr] = meta;
        const sId = parseInt(sIdStr);
        const safeOrderId = oId || "";

        if (type === 'SET_BUDGET') {
          const days = parseInt(text);
          if (isNaN(days)) return sendTelegram(chatId, "❌ Enter a number.");
          const ord = await safeQuery(supabase.from('sample_orders').select('production_workflow').eq('order_id', safeOrderId).single(), ALLOWED_USER_ID, 'GET_WF_BUDGET', safeOrderId);
          if (!ord) return sendTelegram(chatId, "❌ Order not found.");
          
          const wf = validateWF(ord.production_workflow || {});
          wf[sId].assignedDays = days;
          await safeQuery(supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', safeOrderId), ALLOWED_USER_ID, 'SAVE_BUDGET', safeOrderId);
          await sendTelegram(chatId, "✅ Budget Updated.");
        } 
        else if (type === 'SET_START' || type === 'SET_COMP') {
          const iso = parseDateInput(text);
          if (!iso) return sendTelegram(chatId, "❌ Use DD-MM-YYYY (2024+)");
          const ord = await safeQuery(supabase.from('sample_orders').select('production_workflow').eq('order_id', safeOrderId).single(), ALLOWED_USER_ID, 'GET_WF_DATE', safeOrderId);
          if (!ord) return sendTelegram(chatId, "❌ Order not found.");

          const wf = validateWF(ord.production_workflow || {});
          if (type === 'SET_COMP') {
            if (sId > 1 && wf[sId-1].status !== 'completed') return sendTelegram(chatId, `❌ Complete ${STAGE_NAMES[sId-1]} first!`);
            wf[sId] = { ...wf[sId], status: 'completed', actualDate: iso };
            const next = sId + 1;
            if (next <= 5 && wf[next].status !== 'completed') wf[next] = { ...wf[next], status: 'in_progress', startDate: iso, assignedDays: wf[next].assignedDays || 7 };
          } else {
            wf[sId].startDate = iso;
          }
          await safeQuery(supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', safeOrderId), ALLOWED_USER_ID, 'SAVE_DATE', safeOrderId);
          await sendTelegram(chatId, "✅ Date Updated.");
        }
      }
      else if (reply.includes("[DISPATCH|")) {
        const oId = reply.match(/\[DISPATCH\|(.+)\]/)?.[1];
        const parts = sanitizeInput(text, 200).split('|').map(p => sanitizeInput(p, 50));
        if (parts.length === 3 && oId) {
          const [track, courier, dStr] = parts; const iso = parseDateInput(dStr);
          if (iso) {
            await safeQuery(supabase.from('sample_orders').update({ status: 'dispatched', tracking_number: track, courier_name: courier, dispatched_at: iso }).eq('order_id', oId), ALLOWED_USER_ID, 'DISPATCH', oId);
            await sendTelegram(chatId, `✅ <b>Order ${oId} Dispatched.</b>`);
          }
        }
      }
    }
    if (msg.document && msg.document.file_name?.endsWith('.xlsx')) {
        const fileRes = await botAxios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${msg.document.file_id}`);
        const response = await botAxios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
        const rows: any[] = XLSX.utils.sheet_to_json(XLSX.read(response.data, { type: 'buffer' }).Sheets[0]);
        const validRows = rows.filter(r => r.client_email && r.style_name && typeof r.quantity === 'number');
        if (validRows.length > 0) {
            // 1. Resolve Client ID
            const { data: existingClient } = await supabase.from('clients').select('id').eq('email', validRows[0].client_email).maybeSingle();
            let clientId = existingClient?.id;

            if (!clientId) {
                const newClient = await safeQuery(
                  supabase.from('clients').insert([{ 
                    name: sanitizeInput(validRows[0].client_name || 'New', 50), 
                    email: validRows[0].client_email 
                  }]).select('id').single(), 
                  ALLOWED_USER_ID, 
                  'CREATE_CLIENT_EXCEL'
                );
                clientId = newClient?.id;
            }

            // Guard for TypeScript: Ensure clientId is definitely a string
            if (!clientId) {
              await sendTelegram(chatId, "❌ Error: Could not create or find client.");
              return NextResponse.json({ ok: true });
            }

            // 2. Execute Atomic Import via RPC
            const wf = validateWF({ 5: { status: 'in_progress', assignedDays: 7, startDate: new Date().toISOString() } });
            
            await safeQuery(supabase.rpc('create_order_with_styles', {
                order_payload: { 
                  client_id: clientId, 
                  order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`, 
                  status: 'submitted', 
                  production_workflow: wf 
                },
                styles_payload: validRows.map(r => ({ 
                  style_name: sanitizeInput(r.style_name, 50), 
                  quantity: r.quantity 
                }))
            }), ALLOWED_USER_ID, 'IMPORT_ORDER_ATOMIC');

            await sendTelegram(chatId, `✅ <b>Imported ${validRows.length} Styles.</b>`);
        }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) { 
    logAction(ALLOWED_USER_ID || 'SYSTEM', 'FATAL_ERROR', 'ERROR', { msg: err.message }); 
    return NextResponse.json({ ok: true }); 
  }
}