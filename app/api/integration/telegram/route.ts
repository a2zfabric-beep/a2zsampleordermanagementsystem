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

// --- WORKFLOW HELPERS ---
const STAGE_NAMES: Record<number, string> = {
  1: "Fabric Procurement", 2: "Dyeing Stage", 3: "Printing Stage", 4: "Embroidery Stage", 5: "Pattern & Sampling"
};

function calculateSpent(start: string, end?: string) {
  const s = new Date(start).setHours(0, 0, 0, 0);
  const e = (end ? new Date(end) : new Date()).setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor((e - s) / (1000 * 3600 * 24)));
}

// --- DATABASE WRAPPERS ---
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

// --- MAIN ROUTE ---
export async function POST(request: Request) {
  try {
    const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
    const supabase = createSupabaseDirect(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const body = await request.json();

    // 1. CALLBACK QUERY HANDLER
    if (body.callback_query) {
      const cb = body.callback_query;
      const adminId = cb.from.id.toString();
      const chatId = cb.message.chat.id.toString();
      const msgId = cb.message.message_id;
      const data = cb.data;

      // Security: Only allow Bot Admin
      if (adminId !== ALLOWED_USER_ID) {
        await answerCallback(cb.id, "🚫 Unauthorized.");
        return NextResponse.json({ ok: true });
      }

      if (data === "menu_main") {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "📎 Tag Media (Reply)", callback_data: "menu_tag_info" }]] };
        await editTelegram(chatId, msgId, "🏠 <b>Dashboard</b>", mainKeyboard);
      } 
      else if (data === "menu_list") {
        const { text, keyboard } = await getOrderList(supabase);
        await editTelegram(chatId, msgId, text, keyboard);
      }
      else if (data.startsWith("view_")) {
        const { text, keyboard } = await getOrderDetail(supabase, data.replace("view_", ""));
        await editTelegram(chatId, msgId, text, keyboard);
      }
      else if (data.startsWith("dispatch_prompt_")) {
        const oId = data.replace("dispatch_prompt_", "");
        const prompt = `🚚 <b>Dispatching Order:</b> <code>${oId}</code>\n\nReply with:\n<code>Tracking # | Courier | DD-MM-YYYY</code>\n\nOr type <b>cancel</b>`;
        const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `view_${oId}` }]] };
        await sendTelegram(chatId, prompt, { force_reply: true, reply_markup: keyboard });
      }
      else if (data.startsWith("attach_")) {
        const [_, orderId, originalMediaMsgId] = data.split("_");
        const mediaMsg = cb.message.reply_to_message;

        // Check if context is valid and IDs match
        if (!mediaMsg || mediaMsg.message_id.toString() !== originalMediaMsgId) {
            await sendTelegram(chatId, "⚠️ <b>Could not detect media correctly.</b>\nPlease reply to the photo/video again and type /tag.");
            await answerCallback(cb.id, "Context Lost.");
            return NextResponse.json({ ok: true });
        }

        const mediaDate = new Date(mediaMsg.date * 1000).toISOString();
        let fileId = mediaMsg.photo ? mediaMsg.photo[mediaMsg.photo.length - 1].file_id : (mediaMsg.video ? mediaMsg.video.file_id : mediaMsg.document?.file_id);
        let type = mediaMsg.photo ? 'image' : (mediaMsg.video ? 'video' : 'document');

        if (fileId) {
            await supabase.from('order_media').insert([{ order_id: orderId, file_id: fileId, file_type: type, created_at: mediaDate }]);
            
            // Automation: Complete Stage 5
            const { data: order } = await supabase.from('sample_orders').select('production_workflow').eq('order_id', orderId).single();
            if (order) {
                const wf = order.production_workflow || {};
                wf[5] = { ...(wf[5] || { assignedDays: 0 }), status: 'completed', actualDate: mediaDate };
                await supabase.from('sample_orders').update({ production_workflow: wf }).eq('order_id', orderId);
            }

            await editTelegram(chatId, msgId, `✅ <b>Media Attached to ${orderId}</b>\n📅 Date: ${new Date(mediaDate).toLocaleDateString()}\n🔬 Sampling Stage: <b>Completed</b>`);
            await answerCallback(cb.id, "✅ Tagged & Stage 5 Updated");
        }
      }
      // (Add other workflow/status handlers here following same logic)
      return NextResponse.json({ ok: true });
    }

    // 2. MESSAGE HANDLER
    const message = body.message;
    if (!message) return NextResponse.json({ ok: true });

    const userId = message.from.id.toString();
    const chatId = message.chat.id.toString();

    // Security Check
    if (userId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

    if (message.text) {
      const text = message.text;

      // Handle Dispatch Reply
      if (message.reply_to_message?.text?.startsWith('🚚 Dispatching Order:')) {
        const oId = message.reply_to_message.text.match(/(TG-\d+|ORD-\d+)/)?.[0];
        
        if (text.toLowerCase() === 'cancel') {
            await sendTelegram(chatId, "❌ Dispatch process cancelled.");
            return NextResponse.json({ ok: true });
        }

        if (!text.includes('|')) {
            await sendTelegram(chatId, "⚠️ <b>Invalid Format.</b>\nUse: <code>Tracking | Courier | DD-MM-YYYY</code>\nOr type 'cancel'", { force_reply: true });
            return NextResponse.json({ ok: true });
        }

        const parts = text.split('|').map((p: string) => p.trim());
        if (parts.length >= 3) {
            const [tracking, courier, dateStr] = parts; 
            const [d, m, y] = dateStr.split('-');
            await supabase.from('sample_orders').update({ 
                status: 'dispatched', courier_name: courier, tracking_number: tracking, dispatched_at: new Date(`${y}-${m}-${d}`).toISOString() 
            }).eq('order_id', oId);
            await sendTelegram(chatId, `✅ <b>Order ${oId} Dispatched</b>\nTracking: ${tracking}\nCourier: ${courier}`);
        }
        return NextResponse.json({ ok: true });
      }

      // Handle /tag Command
      if (text.startsWith("/tag")) {
        const mediaMsg = message.reply_to_message;
        const hasMedia = mediaMsg && (mediaMsg.photo || mediaMsg.video || mediaMsg.document);

        if (!hasMedia) {
          await sendTelegram(chatId, "❌ <b>Error:</b> Please reply to a photo, video, or document with /tag.");
          return NextResponse.json({ ok: true });
        }

        const { data: orders } = await supabase.rpc('get_orders_without_media');
        const keyboard = { 
            inline_keyboard: (orders || []).map((o: any) => ([{ 
                text: `${o.order_id} | ${o.client_name}`, 
                callback_data: `attach_${o.order_id}_${mediaMsg.message_id}` // Passing Message ID in Callback
            }])) 
        };

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: "📎 <b>Tag this media to:</b>",
            parse_mode: 'HTML',
            reply_to_message_id: mediaMsg.message_id,
            reply_markup: keyboard
        });
      } else if (text === "/start" || text.toLowerCase() === "menu") {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "📎 Tag Media (Reply)", callback_data: "menu_tag_info" }]] };
        await sendTelegram(chatId, "👋 <b>Garment Workflow Admin</b>", mainKeyboard);
      }
    }

    // Excel Import Logic (Keep existing)
    if (message.document && message.document.file_name?.endsWith('.xlsx')) {
        const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${message.document.file_id}`);
        const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
        const workbook = XLSX.read(response.data, { type: 'buffer' });
        const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const firstRow = rows[0];
        const clientEmail = firstRow.client_email?.trim().toLowerCase();
        
        if (clientEmail) {
            let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
            if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: firstRow.client_name || 'New Client', email: clientEmail }]).select().single(); client = nc; }
            
            const initialWF = { 5: { status: 'in_progress', assignedDays: 0, startDate: new Date().toISOString() } };
            const orderId = `TG-${Math.floor(1000 + Math.random() * 9000)}`;
            const { data: order } = await supabase.from('sample_orders').insert([{ client_id: client?.id, order_id: orderId, status: 'submitted', delivery_date: new Date(Date.now() + 21 * 86400000).toISOString(), production_workflow: initialWF }]).select().single();

            if (order) {
                const stylesToInsert = rows.map((r: any, i: number) => ({ order_id: order.id, item_number: r.item_number || `S-${1000 + i}`, style_name: r.style_name || 'Item', quantity: Number(r.quantity) || 1 }));
                await supabase.from('order_styles').insert(stylesToInsert);
                await sendTelegram(chatId, `✅ <b>Order Created: ${orderId}</b>\n🔬 Stage 5 (Sampling) Auto-Started.`);
            }
        }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('Bot Error:', err);
    return NextResponse.json({ ok: true });
  }
}