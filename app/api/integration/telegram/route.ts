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
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  } catch (err: any) {
    console.error('Telegram Send Error:', err.response?.data || err.message);
  }
}

async function editTelegram(chatId: string, messageId: number, text: string, replyMarkup?: any) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  } catch (err: any) {
    console.error('Telegram Edit Error:', err.response?.data || err.message);
  }
}

async function answerCallback(callbackQueryId: string, text: string) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text
    });
  } catch (err: any) {
    console.error('Callback Answer Error:', err.message);
  }
}

// --- DATABASE LOGIC WRAPPERS ---
async function getOrderList(supabase: any) {
  const { data: orders } = await supabase
    .from('sample_orders')
    .select('order_id, status, client:clients(name)')
    .not('status', 'eq', 'dispatched')
    .order('created_at', { ascending: false })
    .limit(15);

  if (!orders || orders.length === 0) {
    return { text: "📋 <b>No active orders found.</b>", keyboard: { inline_keyboard: [[{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]] } };
  }

  const keyboard = {
    inline_keyboard: [
      ...orders.map((o: any) => {
        const clientName = o.client?.name || 'Unknown';
        const displayName = clientName.length > 12 ? clientName.substring(0, 10) + '..' : clientName;
        return [{ text: `${o.order_id} | ${displayName} (${o.status})`, callback_data: `view_${o.order_id}` }];
      }),
      [{ text: "⬅️ Back to Menu", callback_data: "menu_main" }]
    ]
  };
  return { text: "📋 <b>Active Orders</b>\nSelect to view specification:", keyboard };
}

async function getOrderDetail(supabase: any, orderId: string) {
  const { data: order } = await supabase
    .from('sample_orders')
    .select('*, client:clients(name)')
    .eq('order_id', orderId)
    .single();

  if (!order) return { text: "❌ Order not found.", keyboard: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_list" }]] } };

  const { data: styles } = await supabase.from('order_styles').select('*').eq('order_id', order.id);

  const text = `🔖 <b>Order:</b> <code>${order.order_id}</code>\n` +
    `👤 <b>Client:</b> ${order.client?.name || 'N/A'}\n` +
    `🏁 <b>Status:</b> <code>${order.status.toUpperCase()}</code>\n` +
    `📅 <b>Target:</b> ${order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'Flexible'}\n\n` +
    `👕 <b>Styles (${styles?.length || 0}):</b>\n` +
    ((styles || []).map((s: any) => `• <code>${s.item_number}</code>: ${s.style_name} (${s.quantity}pcs)`).join('\n') || '<i>No styles added</i>') +
    `\n\n<b>Update Status:</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔬 Sampling", callback_data: `setstatus_${orderId}_sampling_in_progress` }, { text: "✅ Ready", callback_data: `setstatus_${orderId}_ready` }],
      [{ text: "🚚 Dispatched", callback_data: `setstatus_${orderId}_dispatched` }],
      [{ text: "📋 List", callback_data: "menu_list" }, { text: "🏠 Menu", callback_data: "menu_main" }]
    ]
  };
  return { text, keyboard };
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
        await editTelegram(adminId, msgId, "🏠 <b>Operations Dashboard</b>\nSelect an action:", mainKeyboard);
      } 
      else if (data === "menu_list") {
        const { text, keyboard } = await getOrderList(supabase);
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data === "menu_tag_info") {
          await answerCallback(cb.id, "Reply to an image with /tag");
          await editTelegram(adminId, msgId, "💡 <b>How to Tag:</b>\n1. Find the factory photo\n2. Long-press/Reply to it\n3. Type <code>/tag</code>", { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_main" }]] });
      }
      else if (data === "menu_stats") {
        const { data: orders } = await supabase.from('sample_orders').select('status');
        const stats = (orders || []).reduce((acc: any, curr: any) => { acc[curr.status] = (acc[curr.status] || 0) + 1; return acc; }, {});
        const statsText = `📊 <b>Status Summary</b>\n\n📝 Drafts: ${stats?.draft || 0}\n📨 Submitted: ${stats?.submitted || 0}\n🔬 Sampling: ${stats?.sampling_in_progress || 0}\n✅ Ready: ${stats?.ready || 0}\n🚚 Dispatched: ${stats?.dispatched || 0}`;
        await editTelegram(adminId, msgId, statsText, { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "menu_main" }]] });
      }
      else if (data.startsWith("view_")) {
        const oId = data.replace("view_", "");
        const { text, keyboard } = await getOrderDetail(supabase, oId);
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("setstatus_")) {
        const [_, oId, status] = data.split("_");
        await supabase.from('sample_orders').update({ status }).eq('order_id', oId);
        await answerCallback(cb.id, `✅ Order Updated`);
        const { text, keyboard } = await getOrderDetail(supabase, oId);
        await editTelegram(adminId, msgId, text, keyboard);
      }
      else if (data.startsWith("attach_")) {
        const orderIdString = data.replace('attach_', '');
        const originalMediaMsg = cb.message.reply_to_message;
        if (!originalMediaMsg) { await answerCallback(cb.id, "❌ No media found."); return NextResponse.json({ ok: true }); }
        
        const fileId = originalMediaMsg.photo ? originalMediaMsg.photo[originalMediaMsg.photo.length - 1].file_id : (originalMediaMsg.video ? originalMediaMsg.video.file_id : originalMediaMsg.document.file_id);
        const fileType = originalMediaMsg.photo ? 'image' : (originalMediaMsg.video ? 'video' : 'document');
        
        await supabase.from('order_media').insert([{ order_id: orderIdString, file_id: fileId, file_type: fileType, created_at: new Date(originalMediaMsg.date * 1000).toISOString() }]);
        await answerCallback(cb.id, "✅ Media Attached!");
        await sendTelegram(adminId, `✅ Photo attached to <b>${orderIdString}</b>`);
        
        const { data: remaining } = await supabase.rpc('get_orders_without_media');
        if (!remaining || remaining.length === 0) {
            await editTelegram(adminId, msgId, "✅ <b>All orders tagged.</b>", { inline_keyboard: [[{ text: "🏠 Main Menu", callback_data: "menu_main" }]] });
        } else {
            const keyboard = { inline_keyboard: remaining.map((o: any) => ([{ text: `${o.order_id} | ${o.client_name}`, callback_data: `attach_${o.order_id}` }])) };
            await editTelegram(adminId, msgId, "📎 <b>Select next order to tag:</b>", keyboard);
        }
      }
      return NextResponse.json({ ok: true });
    }

    const message = body.message;
    const userId = message?.from?.id?.toString();
    if (userId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

    const text = message?.text;
    if (text) {
      const command = text.split(' ')[0].toLowerCase();
      
      if (command === "/tag") {
        const replyTo = message.reply_to_message;
        if (!replyTo) {
            await sendTelegram(userId, "⚠️ Please <b>reply to a photo</b> with /tag.");
            return NextResponse.json({ ok: true });
        }
        const { data: orders } = await supabase.rpc('get_orders_without_media');
        if (!orders || orders.length === 0) {
            await sendTelegram(userId, "✅ <b>All orders are already tagged.</b>");
            return NextResponse.json({ ok: true });
        }
        const keyboard = { inline_keyboard: orders.map((o: any) => ([{ text: `${o.order_id} | ${o.client_name}`, callback_data: `attach_${o.order_id}` }])) };
        await sendTelegram(userId, "📎 <b>Attach to:</b>", keyboard);
      } 
      else {
        const mainKeyboard = { inline_keyboard: [[{ text: "📋 List Orders", callback_data: "menu_list" }, { text: "📊 Stats", callback_data: "menu_stats" }], [{ text: "📎 Tag Media (Reply)", callback_data: "menu_tag_info" }]] };
        await sendTelegram(userId, "👋 <b>A2Z Operations Bot</b>\nSelect an action:", mainKeyboard);
      }
    }

    if (message?.document) {
      const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${message.document.file_id}`);
      const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
      const workbook = XLSX.read(response.data, { type: 'buffer' });
      const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      if (rows.length === 0) return NextResponse.json({ ok: true });
      const firstRow = rows[0];
      const clientEmail = firstRow.client_email?.trim().toLowerCase();
      if (!clientEmail) return NextResponse.json({ ok: true });
      let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
      if (!client) { const { data: nc } = await supabase.from('clients').insert([{ name: firstRow.client_name || 'New Client', email: clientEmail }]).select().single(); client = nc; }
      if (!client) return NextResponse.json({ ok: true });
      const { data: order } = await supabase.from('sample_orders').insert([{ client_id: client.id, order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`, status: 'submitted', delivery_date: new Date(Date.now() + 21 * 86400000).toISOString(), created_by: 'automation', order_source: 'email' }]).select().single();
      if (order) {
        const stylesToInsert = rows.map((r: any, i: number) => ({ order_id: order.id, item_number: r.item_number || `STYLE-${1000 + i}`, style_name: r.style_name || 'Item', quantity: Number(r.quantity) || 1 }));
        await supabase.from('order_styles').insert(stylesToInsert);
        await sendTelegram(userId, `✅ <b>Order Created: ${order.order_id}</b>`);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('Bot Error:', err);
    return NextResponse.json({ ok: true });
  }
}