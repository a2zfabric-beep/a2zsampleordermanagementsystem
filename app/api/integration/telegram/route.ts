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

// --- WORKFLOW LOGIC HELPERS ---
const STAGE_NAMES: Record<number, string> = {
  1: "Fabric Procurement", 2: "Dyeing Stage", 3: "Printing Stage", 4: "Embroidery Stage", 5: "Pattern & Sampling"
};

function calculateSpent(start: string, end?: string) {
  const s = new Date(start).setHours(0, 0, 0, 0);
  const e = (end ? new Date(end) : new Date()).setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((e - s) / (1000 * 3600 * 24)));
}

// --- DATABASE LOGIC WRAPPERS ---
async function getOrderList(supabase: any) {
  const { data: orders } = await supabase.from('sample_orders').select('order_id, status, client:clients(name)').not('status', 'eq', 'dispatched').order('created_at', { ascending: false }).limit(15);
  if (!orders || orders.length === 0) return { text: "📋 <b>No active orders found.</b>", keyboard: { inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]] } };
  const keyboard = { inline_keyboard: [...orders.map((o: any) => {
    const cName = o.client?.name || 'Unknown';
    const display = cName.length > 12 ? cName.substring(0, 10) + '..' : cName;
    return [{ text: `${o.order_id} | ${display} (${o.status})`, callback_data: `view_${o.order_id}` }];
  }), [{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]] };
  return { text: "📋 <b>Active Orders</b>\nSelect an order:", keyboard };
}

async function getOrderDetail(supabase: any, orderId: string) {
  const { data: order } = await supabase.from('sample_orders').select('*, client:clients(name)').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Order not found.", keyboard: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_list" }]] } };
  const { data: styles } = await supabase.from('order_styles').select('*').eq('order_id', order.id);
  const text = `🔖 <b>Order:</b> <code>${order.order_id}</code>\n👤 <b>Client:</b> ${order.client?.name || 'N/A'}\n🏁 <b>Status:</b> <code>${order.status.toUpperCase()}</code>\n📅 <b>Target:</b> ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'Flexible'}\n\n👕 <b>Styles (${styles?.length || 0}):</b>\n` +
    ((styles || []).map((s: any) => `• <code>${s.item_number}</code>: ${s.style_name} (${s.quantity}pcs)`).join('\n') || '<i>No styles added</i>');

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
  if (!order) return { text: "❌ Order not found.", keyboard: null };
  const stages = order.production_workflow || {};
  let text = `⚙️ <b>Workflow Tracker: ${orderId}</b>\n\n`;
  const buttons = [];
  for (let i = 1; i <= 5; i++) {
    const s = stages[i] || { status: 'pending', assignedDays: 0 };
    const icon = s.status === 'completed' ? '✅' : (s.status === 'in_progress' ? '🔵' : (s.status === 'na' ? '⚪' : '🕒'));
    const spent = s.startDate ? calculateSpent(s.startDate, s.actualDate) : 0;
    const delayWarn = (spent > s.assignedDays && s.assignedDays > 0 && s.status !== 'completed') ? '⚠️' : '';
    text += `${icon} <b>${STAGE_NAMES[i]}</b>\n   Status: <i>${s.status.replace('_', ' ')}</i>\n   Time: ${spent}d / ${s.assignedDays}d ${delayWarn}\n\n`;
    buttons.push([{ text: `${icon} Manage ${STAGE_NAMES[i]}`, callback_data: `wf_stage_${orderId}_${i}` }]);
  }
  buttons.push([{ text: "⬅️ Back to Order Detail", callback_data: `view_${orderId}` }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

async function getStageDetail(supabase: any, orderId: string, stageId: number) {
  const { data: order } = await supabase.from('sample_orders').select('order_id, production_workflow').eq('order_id', orderId).single();
  if (!order) return { text: "❌ Order not found.", keyboard: null };
  const stages = order.production_workflow || {};
  const s = stages[stageId] || { status: 'pending', assignedDays: 0 };
  const prev = stages[stageId - 1];
  const isLocked = stageId > 1 && (!prev || (prev.status !== 'completed' && prev.status !== 'na'));
  let text = `🏗️ <b>${STAGE_NAMES[stageId]}</b>\nOrder: <code>${orderId}</code>\n\n📌 Status: <b>${s.status.toUpperCase()}</b>\n📅 Start: ${s.startDate ? new Date(s.startDate).toLocaleDateString() : 'Not started'}\n📅 End: ${s.actualDate ? new Date(s.actualDate).toLocaleDateString() : 'Not finished'}\n⏱ Allocated: ${s.assignedDays} Days\n`;
  if (s.startDate) text += `⏳ Used So Far: ${calculateSpent(s.startDate, s.actualDate)} Days\n`;
  if (isLocked) text += `\n🔒 <i>Locked: Complete ${STAGE_NAMES[stageId-1]} first.</i>`;
  const buttons = [];
  if (!isLocked) {
    if (s.status === 'pending') {
      buttons.push([{ text: "🚀 Start Stage (Manual Date)", callback_data: `wf_prompt_start_${orderId}_${stageId}` }]);
      buttons.push([{ text: "⚪ Not Required", callback_data: `wf_update_${orderId}_${stageId}_na` }]);
    } else if (s.status === 'in_progress') {
      buttons.push([{ text: "✅ Mark Completed (Manual Date)", callback_data: `wf_prompt_complete_${orderId}_${stageId}` }]);
    }
    const canReset = s.status !== 'pending' && (stageId === 5 || (stages[stageId + 1]?.status === 'pending'));
    if (canReset) buttons.push([{ text: "🔄 Reset Stage", callback_data: `wf_reset_${orderId}_${stageId}` }]);
  }
  buttons.push([{ text: "📅 Set Budget Days", callback_data: `wf_prompt_budget_${orderId}_${stageId}` }]);
  buttons.push([{ text: "⬅️ Back to Workflow Hub", callback_data: `wf_hub_${orderId}` }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

export async function POST(request: Request) {
  try {
    const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
    const supabase = createSupabaseDirect(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const body = await request.json();

    if (body.callback_query) {
      const cb = body.callback_query;
      const adminId = cb.from.id.toString();
      const msgId = cb.message.message_id;
      if (adminId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });
      const data = cb.data;

      if (data === "menu_main") {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "📎 Tag Media (Reply)", callback_data: "menu_tag_info" }]] };
        await editTelegram(adminId, msgId, "🏠 <b>Dashboard</b>", mainKeyboard);
      } 
      else if (data === "menu_list") {
        const { text, keyboard } = await getOrderList(supabase);
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("view_")) {
        const { text, keyboard } = await getOrderDetail(supabase, data.replace("view_", ""));
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("wf_hub_")) {
        const { text, keyboard } = await getWorkflowHub(supabase, data.replace("wf_hub_", ""));
        if (keyboard) await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("wf_stage_")) {
        const [_, __, oId, sId] = data.split("_");
        const { text, keyboard } = await getStageDetail(supabase, oId, parseInt(sId));
        if (keyboard) await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("wf_update_")) {
        const [_, __, oId, sId, status] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            stages[stageNum] = { ...stages[stageNum], status, startDate: status === 'in_progress' ? new Date().toISOString() : stages[stageNum].startDate, actualDate: status === 'na' ? new Date().toISOString() : null };
            if (status === 'na' && stageNum < 5) {
                if (!stages[stageNum + 1]) stages[stageNum + 1] = { status: 'pending', assignedDays: 0 };
                stages[stageNum + 1].startDate = new Date().toISOString();
            }
            await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId);
            const { text, keyboard } = await getStageDetail(supabase, oId, stageNum);
            if (keyboard) await editTelegram(adminId, msgId, text, keyboard);
        }
      }
      else if (data.startsWith("wf_reset_")) {
        const [_, __, oId, sId] = data.split("_");
        const stageNum = parseInt(sId);
        const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
        if (order) {
            const stages = order.production_workflow || {};
            stages[stageNum] = { ...stages[stageNum], status: 'pending', actualDate: null };
            if (stageNum < 5 && stages[stageNum + 1]) stages[stageNum + 1].startDate = null;
            await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId);
            const { text, keyboard } = await getStageDetail(supabase, oId, stageNum);
            if (keyboard) await editTelegram(adminId, msgId, text, keyboard);
        }
      }
      else if (data.startsWith("wf_prompt_start_")) {
        const [_, __, ___, oId, sId] = data.split("_");
        await sendTelegram(adminId, `📅 <b>Start Stage: ${STAGE_NAMES[parseInt(sId)]}</b>\nOrder: <code>${oId}</code>\n\nReply with Start Date (DD-MM-YYYY) or "today"`, { force_reply: true });
      }
      else if (data.startsWith("wf_prompt_budget_")) {
        const [_, __, ___, oId, sId] = data.split("_");
        await sendTelegram(adminId, `🔢 <b>Set Budget for ${STAGE_NAMES[parseInt(sId)]}</b>\nOrder: <code>${oId}</code>\n\nReply with days (e.g. 5)`, { force_reply: true });
      }
      else if (data.startsWith("wf_prompt_complete_")) {
        const [_, __, ___, oId, sId] = data.split("_");
        await sendTelegram(adminId, `✅ <b>Complete Stage: ${STAGE_NAMES[parseInt(sId)]}</b>\nOrder: <code>${oId}</code>\n\nReply with completion date (DD-MM-YYYY) or "today"`, { force_reply: true });
      }
      else if (data.startsWith("dispatch_prompt_")) {
        const oId = data.replace("dispatch_prompt_", "");
        const prompt = `🚚 <b>Dispatching Order:</b> <code>${oId}</code>\n\nReply: <code>Tracking # | Courier | DD-MM-YYYY</code>`;
        const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `view_${oId}` }]] };
        await sendTelegram(adminId, prompt, { force_reply: true, reply_markup: keyboard });
      }
      else if (data.startsWith("setstatus_")) {
        const [_, oId, status] = data.split("_");
        await supabase.from('sample_orders').update({ status }).eq('order_id', oId);
        const { text, keyboard } = await getOrderDetail(supabase, oId);
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("attach_")) {
        const orderIdString = data.replace('attach_', '');
        const originalMediaMsg = cb.message.reply_to_message;
        if (originalMediaMsg) {
            const mediaDate = new Date(originalMediaMsg.date * 1000).toISOString();
            let fileId = originalMediaMsg.photo ? originalMediaMsg.photo[originalMediaMsg.photo.length - 1].file_id : (originalMediaMsg.video ? originalMediaMsg.video.file_id : originalMediaMsg.document.file_id);
            await supabase.from('order_media').insert([{ order_id: orderIdString, file_id: fileId, file_type: originalMediaMsg.photo ? 'image' : (originalMediaMsg.video ? 'video' : 'document'), created_at: mediaDate }]);
            
            // AUTOMATION: Hook Stage 5 Completion on Tagging
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', orderIdString).single();
            if(order) {
                const wf = order.production_workflow || {};
                wf[5] = { ...wf[5], status: 'completed', actualDate: mediaDate };
                await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', orderIdString);
            }

            await answerCallback(cb.id, "✅ Attached & Stage 5 Completed!");
            const { data: remaining } = await supabase.rpc('get_orders_without_media');
            if (!remaining || remaining.length === 0) await editTelegram(adminId, msgId, "✅ <b>All tagged.</b>");
            else { const keyboard = { inline_keyboard: remaining.map((o: any) => ([{ text: `${o.order_id} | ${o.client_name}`, callback_data: `attach_${o.order_id}` }])) }; await editTelegram(adminId, msgId, "📎 <b>Tag next:</b>", keyboard); }
        }
      }
      return NextResponse.json({ ok: true });
    }

    const message = body.message;
    const userId = message?.from?.id?.toString();
    if (userId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

    if (message?.text) {
      const text = message.text;
      if (message.reply_to_message) {
        const rText = message.reply_to_message.text;
        const oIdMatch = rText.match(/(TG-\d+|ORD-\d+)/);
        if (oIdMatch) {
          const oId = oIdMatch[0];
          const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', oId).single();
          if (order) {
            const stages = order.production_workflow || {};
            const parseDate = (input: string) => input.toLowerCase() === 'today' ? new Date().toISOString() : (()=>{ const [d,m,y] = input.split('-'); return new Date(`${y}-${m}-${d}`).toISOString(); })();

            if (rText.includes('Start Stage')) {
                const stageId = Object.keys(STAGE_NAMES).find(key => rText.includes(STAGE_NAMES[parseInt(key)]));
                if (stageId) { const d = parseDate(text); stages[stageId] = { ...stages[stageId], status: 'in_progress', startDate: d }; await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId); await sendTelegram(userId, "✅ Start date set."); }
            }
            else if (rText.includes('Set Budget')) {
              const stageId = Object.keys(STAGE_NAMES).find(key => rText.includes(STAGE_NAMES[parseInt(key)]));
              if (stageId) { stages[stageId] = { ...stages[stageId], assignedDays: parseInt(text) || 0 }; await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId); await sendTelegram(userId, "✅ Budget updated"); }
            }
            else if (rText.includes('Complete Stage')) {
              const stageId = parseInt(Object.keys(STAGE_NAMES).find(key => rText.includes(STAGE_NAMES[parseInt(key)])) || "0");
              const dateStr = parseDate(text);
              stages[stageId] = { ...stages[stageId], status: 'completed', actualDate: dateStr };
              if (stageId < 5) { if (!stages[stageId + 1]) stages[stageId + 1] = { status: 'pending', assignedDays: 0 }; stages[stageId + 1].startDate = dateStr; }
              await supabase.from('sample_orders').update({ production_workflow: stages }).eq('order_id', oId); await sendTelegram(userId, "✅ Stage completed");
            }
            else if (rText.includes('Dispatching Order:')) {
              const parts = text.split('|').map((p: string) => p.trim());
              if (parts.length >= 3) {
                  const [tracking, courier, dateStr] = parts; const [d, m, y] = dateStr.split('-');
                  await supabase.from('sample_orders').update({ status: 'dispatched', courier_name: courier, tracking_number: tracking, dispatched_at: new Date(`${y}-${m}-${d}`).toISOString() }).eq('order_id', oId);
                  await sendTelegram(userId, `✅ <b>${oId} Dispatched</b>`);
              }
            }
          }
        }
        return NextResponse.json({ ok: true });
      }

      if (text.startsWith("/tag")) {
        const { data: orders } = await supabase.rpc('get_orders_without_media');
        const keyboard = { inline_keyboard: (orders || []).map((o: any) => ([{ text: `${o.order_id} | ${o.client_name}`, callback_data: `attach_${o.order_id}` }])) };
        await sendTelegram(userId, "📎 <b>Attach to:</b>", keyboard);
      } else {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "📎 Tag Media (Reply)", callback_data: "menu_tag_info" }]] };
        await sendTelegram(userId, "👋 <b>Dashboard</b>", mainKeyboard);
      }
    }

    if (message?.document) {
      const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${message.document.file_id}`);
      const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
      const workbook = XLSX.read(response.data, { type: 'buffer' });
      const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      const firstRow = rows[0];
      const clientEmail = firstRow.client_email?.trim().toLowerCase();
      if (clientEmail) {
        let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
        if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: firstRow.client_name || 'New Client', email: clientEmail }]).select().single(); client = nc; }
        
        // AUTOMATION: Hook Stage 5 auto-start on order creation
        const initialWF = { 5: { status: 'in_progress', assignedDays: 0, startDate: new Date().toISOString() } };
        
        const { data: order } = await supabase.from('sample_orders').insert([{
            client_id: client?.id,
            order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`,
            status: 'submitted',
            delivery_date: new Date(Date.now() + 21 * 86400000).toISOString(),
            created_by: 'automation',
            order_source: 'email',
            production_workflow: initialWF
        }]).select().single();

        if (order) {
            const stylesToInsert = rows.map((r: any, i: number) => ({ order_id: order.id, item_number: r.item_number || `STYLE-${1000 + i}`, style_name: r.style_name || 'Item', quantity: Number(r.quantity) || 1 }));
            await supabase.from('order_styles').insert(stylesToInsert);
            await sendTelegram(userId, `✅ Order Created: ${order.order_id}\n🔬 Pattern & Sampling Auto-Started.`);
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) { console.error('Bot Error:', err); return NextResponse.json({ ok: true }); }
}