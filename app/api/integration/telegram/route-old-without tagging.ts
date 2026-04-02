import { createClient as createSupabaseDirect } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import axios from 'axios';

export const dynamic = 'force-dynamic';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- HELPERS ---
async function sendTelegram(chatId: string, text: string, replyMarkup?: any) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup
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
  const text = `🔖 <b>ID:</b> <code>${order.order_id}</code>\n👤 <b>Client:</b> ${order.client?.name || 'N/A'}\n🏁 <b>Status:</b> <code>${order.status.toUpperCase()}</code>\n📅 <b>Target:</b> ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString() : 'Flexible'}\n\n👕 <b>Styles:</b>\n` +
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
  let text = `⚙️ <b>Workflow: ${orderId}</b>\n\n`;
  const buttons = [];
  for (let i = 1; i <= 5; i++) {
    const s = stages[i] || { status: 'pending', assignedDays: 0 };
    const icon = s.status === 'completed' ? '✅' : (s.status === 'in_progress' ? '🔵' : (s.status === 'na' ? '⚪' : '🕒'));
    const spent = s.startDate ? calculateSpent(s.startDate, s.actualDate) : 0;
    text += `${icon} <b>${STAGE_NAMES[i]}</b>\n   Status: <i>${s.status}</i>\n   Time: ${spent}d / ${s.assignedDays || 0}d\n\n`;
    buttons.push([{ text: `${icon} Manage ${STAGE_NAMES[i]}`, callback_data: `wf_stage_${orderId}_${i}` }]);
  }
  buttons.push([{ text: "⬅️ Back to Detail", callback_data: `view_${orderId}` }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

async function getStageDetail(supabase: any, orderId: string, stageId: number) {
  const { data: order } = await supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Not found.", keyboard: null };
  const s = (order.production_workflow || {})[stageId] || { status: 'pending', assignedDays: 0 };
  let text = `🏗️ <b>${STAGE_NAMES[stageId]}</b>\nID: <code>${orderId}</code>\n\n📌 Status: <b>${s.status.toUpperCase()}</b>\n📅 Start: ${s.startDate ? new Date(s.startDate).toLocaleDateString() : 'Not started'}\n⏱ Budget: ${s.assignedDays} Days\n`;
  if (s.startDate) text += `⏳ Used So Far: ${calculateSpent(s.startDate, s.actualDate)} Days\n`;
  
  const buttons = [
    [{ text: "✅ Mark Completed", callback_data: `wf_update_${orderId}_${stageId}_completed` }],
    [{ text: "📅 Set Budget Days", callback_data: `wf_prompt_budget_${orderId}_${stageId}` }],
    [{ text: "🔄 Reset Stage", callback_data: `wf_reset_${orderId}_${stageId}` }],
    [{ text: "⬅️ Back to Workflow Hub", callback_data: `wf_hub_${orderId}` }]
  ];
  return { text, keyboard: { inline_keyboard: buttons } };
}

// --- MAIN ROUTE ---
export async function POST(request: Request) {
  try {
    const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
    const supabase = createSupabaseDirect(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const body = await request.json();

    if (body.callback_query) {
      const cb = body.callback_query;
      const adminId = cb.from.id.toString();
      const chatId = cb.message.chat.id.toString();
      const msgId = cb.message.message_id;
      const data = cb.data;

      if (adminId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

      if (data.startsWith("asgn_mode_")) {
        const [_, __, mediaId, mode] = data.split("_");
        if (mode === "standalone") {
            const orderId = `TASK-${Math.floor(1000 + Math.random() * 9000)}`;
            let { data: client } = await supabase.from('clients').select('id').eq('name', 'Internal Factory').single();
            if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: 'Internal Factory', email: `factory_${Date.now()}@internal.com` }]).select().single(); client = nc; }
            // Waterfall: Standalone task completes 1-4 and starts 5
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
            // WATERFALL: Complete all previous stages
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
      else if (data === "menu_main") {
        const mainKeyboard = { 
  inline_keyboard: [
    [{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }],
    [{ text: "⏳ Pending Tasks", callback_data: "menu_pending" }]
  ] 
};
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
            const activeId = Object.keys(wf).find(k => wf[k].status === 'in_progress');
            if (activeId) {
                const s = wf[activeId];
                const budget = s.assignedDays || 0;
                const due = new Date(new Date(s.startDate).getTime() + budget * 86400000);
                const diff = Math.ceil((due.getTime() - new Date().getTime()) / 86400000);
                const dueStr = diff >= 0 ? `${diff}d left` : `⚠️ ${Math.abs(diff)}d overdue`;
                response += `👤 ${o.client?.name || 'N/A'} | <code>${o.order_id}</code>\n📍 ${STAGE_NAMES[parseInt(activeId)]} | ${dueStr}\n\n`;
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
      else if (data.startsWith("wf_prompt_budget_")) {
        const [_, __, ___, oId, sId] = data.split("_");
        await sendTelegram(chatId, `🔢 <b>Set Budget (Days) for ${STAGE_NAMES[parseInt(sId)]}</b>\nID: <code>${oId}</code>\n\nReply with a number (e.g., 5)`, { force_reply: true });
      }
      else if (data.startsWith("wf_update_")) {
        const [_, __, oId, sId, status] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            stages[stageNum] = { ...stages[stageNum], status, actualDate: status === 'completed' ? new Date().toISOString() : stages[stageNum].actualDate };
            if (status === 'completed' && stageNum < 5) {
                if (!stages[stageNum + 1]) stages[stageNum + 1] = { status: 'pending', assignedDays: 7 };
                stages[stageNum + 1].startDate = new Date().toISOString();
                stages[stageNum + 1].status = 'in_progress';
            }
            await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId);
            const { text, keyboard } = await getWorkflowHub(supabase, oId);
            if (keyboard) await editTelegram(chatId, msgId, text, keyboard);
        }
      }
      else if (data.startsWith("wf_reset_")) {
        const [_, __, oId, sId] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('status, production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            stages[stageNum] = { ...stages[stageNum], status: 'pending', actualDate: null };
            let newStatus = order.status;
            if (stageNum === 5 && order.status === 'ready') newStatus = 'sampling_in_progress';
            await supabase.from('sample_orders').update({ production_workflow: stages, status: newStatus }).eq('order_id', oId);
            const { text, keyboard } = await getStageDetail(supabase, oId, stageNum);
            await editTelegram(chatId, msgId, text, keyboard);
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
        if (mediaMsg) {
            const mediaDate = new Date(mediaMsg.date * 1000).toISOString();
            const fileId = mediaMsg.photo ? mediaMsg.photo[mediaMsg.photo.length - 1].file_id : (mediaMsg.video ? mediaMsg.video.file_id : mediaMsg.document?.file_id);
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

      if (message.reply_to_message?.text?.startsWith('🚚 Dispatching Order:')) {
        const oId = message.reply_to_message.text.match(/(TG-\d+|ORD-\d+|FAC-\d+|TASK-\d+)/)?.[0];
        if (text.toLowerCase() === 'cancel') { await sendTelegram(chatId, "❌ Dispatch cancelled."); return NextResponse.json({ ok: true }); }
        const parts = text.split('|').map((p: string) => p.trim());
        if (parts.length >= 3) {
            const [tracking, courier, dateStr] = parts; const [d, m, y] = dateStr.split('-');
            await supabase.from('sample_orders').update({ status: 'dispatched', courier_name: courier, tracking_number: tracking, dispatched_at: new Date(`${y}-${m}-${d}`).toISOString() }).eq('order_id', oId);
            await sendTelegram(chatId, `✅ <b>Order ${oId} Dispatched</b>`);
        } else { await sendTelegram(chatId, "⚠️ Invalid format. Use: Tracking | Courier | DD-MM-YYYY", { force_reply: true }); }
        return NextResponse.json({ ok: true });
      }

      if (message.reply_to_message?.text?.includes('Set Budget (Days)')) {
        const oId = message.reply_to_message.text.match(/(TG-\d+|ORD-\d+|TASK-\d+)/)?.[0];
        const sName = message.reply_to_message.text.match(/for (.*)\n/)?.[1];
        const sId = Object.keys(STAGE_NAMES).find(key => STAGE_NAMES[parseInt(key)] === sName);
        if (oId && sId) {
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
            if (order) {
                const wf = order.production_workflow || {};
                wf[sId] = { ...(wf[sId] || {}), assignedDays: parseInt(text) || 0 };
                await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', oId);
                await sendTelegram(chatId, `✅ Budget set to ${text} days for ${sName}.`);
            }
        }
        return NextResponse.json({ ok: true });
      }

      if (text.startsWith("/assign") || text.startsWith("/task")) {
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg) { await sendTelegram(chatId, "❌ Please reply to a media message with /assign"); return NextResponse.json({ ok: true }); }
        const keyboard = { inline_keyboard: [[{ text: "🆕 Standalone Task", callback_data: `asgn_mode_${mediaMsg.message_id}_standalone` }], [{ text: "🔗 Associate to Order", callback_data: `asgn_mode_${mediaMsg.message_id}_associate` }]] };
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: "🛠 <b>Assignment Engine:</b>", parse_mode: 'HTML', reply_to_message_id: mediaMsg.message_id, reply_markup: keyboard });
      }
      else if (text.startsWith("/tag")) {
        const mediaMsg = message.reply_to_message;
        if (!mediaMsg) return NextResponse.json({ ok: true });
        const { data: orders } = await supabase.from('sample_orders').select('order_id, client:clients(name)').not('status', 'eq', 'dispatched').order('created_at', { ascending: false }).limit(10);
        const buttons = (orders || []).map((o: any) => ([{ text: `${o.order_id} | ${o.client?.name || 'Client'}`, callback_data: `attach_${o.order_id}_${mediaMsg.message_id}` }]));
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: chatId, text: "📎 <b>Tag media to:</b>", parse_mode: 'HTML', reply_to_message_id: mediaMsg.message_id, reply_markup: { inline_keyboard: buttons } });
      }
      else if (text.startsWith("/pending")) {
        const { data: orders } = await supabase.from('sample_orders').select('order_id, production_workflow, client:clients(name)').not('status', 'eq', 'dispatched');
        let response = "⏳ <b>Live Pending Tasks</b>\n\n";
        (orders || []).forEach((o: any) => {
            const wf = o.production_workflow || {};
            const activeId = Object.keys(wf).find(k => wf[k].status === 'in_progress');
            if (activeId) {
                const s = wf[activeId];
                const budget = s.assignedDays || 0;
                const due = new Date(new Date(s.startDate).getTime() + budget * 86400000);
                const diff = Math.ceil((due.getTime() - new Date().getTime()) / 86400000);
                const dueStr = diff >= 0 ? `🟢 ${diff} days left` : `🔴 OVERDUE ${Math.abs(diff)} days`;
                response += `👤 <b>${o.client?.name || 'N/A'}</b>\n📦 ${o.order_id} (${STAGE_NAMES[parseInt(activeId)]})\n📅 ${dueStr}\n\n`;
            }
        });
        await sendTelegram(chatId, response || "✅ No pending tasks found.");
      }
      else if (text === "/start" || text.toLowerCase() === "menu") {
        const mainKeyboard = { 
          inline_keyboard: [
            [{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }],
            [{ text: "⏳ Pending Tasks", callback_data: "menu_pending" }]
          ] 
        };
        await sendTelegram(chatId, "👋 <b>Garment Admin Dashboard</b>", mainKeyboard);
      }
    }

    if (message.document && message.document.file_name?.endsWith('.xlsx')) {
        const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${message.document.file_id}`);
        const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
        const rows: any[] = XLSX.utils.sheet_to_json(XLSX.read(response.data, { type: 'buffer' }).Sheets[0]);
        const clientEmail = rows[0]?.client_email?.trim().toLowerCase();
        if (clientEmail) {
            let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
            if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: rows[0].client_name, email: clientEmail }]).select().single(); client = nc; }
            const initialWF = { 5: { status: 'in_progress', assignedDays: 7, startDate: new Date().toISOString() } };
            const { data: order } = await supabase.from('sample_orders').insert([{ client_id: client?.id, order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`, status: 'submitted', production_workflow: initialWF }]).select().single();
            if (order) { await supabase.from('order_styles').insert(rows.map((r: any) => ({ order_id: order.id, style_name: r.style_name, quantity: r.quantity }))); await sendTelegram(chatId, `✅ <b>Order Imported.</b>`); }
        }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) { console.error('Bot Error:', err); return NextResponse.json({ ok: true }); }
}