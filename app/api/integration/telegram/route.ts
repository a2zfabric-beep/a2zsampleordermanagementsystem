import { createClient as createSupabaseDirect } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import axios from 'axios';

// This prevents Next.js from trying to "pre-render" this route during build
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID; 

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabase = createSupabaseDirect(supabaseUrl, supabaseKey);

    const body = await request.json();

    // 1. Security Check
    const userId = body.message?.from?.id?.toString();
    if (userId !== ALLOWED_USER_ID) {
      return NextResponse.json({ ok: true });
    }

    // 2. Handle Text Messages & Commands
    const text = body.message?.text;
    if (text) {
      const isCommand = text.startsWith('/');
      
      // COMMAND: /stats - Quick Operations Summary
      if (text === '/stats') {
        const { data: orders } = await supabase.from('sample_orders').select('status');
        const stats = orders?.reduce((acc: any, curr: any) => {
          acc[curr.status] = (acc[curr.status] || 0) + 1;
          return acc;
        }, {});

        const message = 
          `📊 *Operations Summary*\n\n` +
          `📝 Drafts: *${stats?.draft || 0}*\n` +
          `📨 Submitted: *${stats?.submitted || 0}*\n` +
          `🔬 Sampling: *${stats?.sampling_in_progress || 0}*\n` +
          `📦 Ready: *${stats?.ready || 0}*\n` +
          `🚚 Dispatched: *${stats?.dispatched || 0}*`;

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: message,
          parse_mode: 'Markdown'
        });
        return NextResponse.json({ ok: true });
      }

      // COMMAND: /delayed - Identify Bottlenecks
      if (text === '/delayed') {
        const { data: orders } = await supabase
          .from('sample_orders')
          .select('order_id, delivery_date, client:clients(name)')
          .not('status', 'in', '("dispatched", "ready")');

        const now = new Date();
        const delayed = orders?.filter(o => o.delivery_date && new Date(o.delivery_date) < now) || [];

        let message = `⚠️ *DELAYED ORDERS (${delayed.length})*\n\n`;
        if (delayed.length === 0) {
          message = "✅ *All orders are currently on track!*";
        } else {
          delayed.forEach(o => {
            message += `• \`${o.order_id}\` | ${o.client?.name || 'Unknown'}\n   📅 Target: ${new Date(o.delivery_date).toLocaleDateString()}\n\n`;
          });
        }

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: message,
          parse_mode: 'Markdown'
        });
        return NextResponse.json({ ok: true });
      }

      // PRESERVE: Handle "Hi" or any other non-command text
      if (!isCommand) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: "👋 *Hello Admin!*\n\nI am ready for instructions. You can use the menu for /stats or send me an Excel template to create a new order.",
          parse_mode: 'Markdown'
        });
      }
      return NextResponse.json({ ok: true });
    }

    // 3. Handle Documents (Excel)
    const document = body.message?.document;
    if (!document) return NextResponse.json({ ok: true });

    // 4. Get File from Telegram
    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${document.file_id}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    // 5. Parse Excel
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const workbook = XLSX.read(response.data, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) throw new Error("Excel sheet is empty.");

    const firstRow = rows[0];
    const clientEmail = firstRow.client_email?.trim().toLowerCase();
    const clientName = firstRow.client_name || 'New Client';
    
    if (!clientEmail) throw new Error("Column 'client_email' is missing.");

    // 6. Find or Create Client
    let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
    if (!client) {
        const { data: newClient, error: cErr } = await supabase
            .from('clients')
            .insert([{ name: clientName, email: clientEmail }])
            .select().single();
        if (cErr) throw cErr;
        client = newClient;
    }

    // 7. Create Order
    const deliveryDate = firstRow.delivery_date ? new Date(firstRow.delivery_date) : new Date(Date.now() + 21 * 86400000);
    const { data: order, error: orderErr } = await supabase
      .from('sample_orders')
      .insert([{
        client_id: client?.id,
        order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`,
        status: 'submitted',
        delivery_date: deliveryDate.toISOString(),
        created_by: 'automation',
        order_source: 'email',
        priority: firstRow.priority?.toLowerCase() || 'medium'
      }])
      .select().single();

    if (orderErr) throw orderErr;

    // 8. Add Styles
    const nameParts = clientName.split(' ');
    const initials = nameParts.length > 1 
      ? (nameParts[0].substring(0, 2) + nameParts[1].substring(0, 2)).toUpperCase()
      : clientName.substring(0, 4).toUpperCase();

    const stylesToInsert = rows.map((row, index) => ({
      order_id: order.id,
      item_number: row.item_number || `${initials}-${1000 + index + 1}`,
      style_name: row.style_name || 'General Clothing',
      fabric: row.fabric || 'TBD',
      color_name: row.color || 'TBD',
      quantity: Number(row.quantity) || 1,
      print_type: 'solid_dyed'
    }));

    await supabase.from('order_styles').insert(stylesToInsert);

    // 9. Success Reply
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: `✅ Order Created: ${order.order_id}\nStyles: ${stylesToInsert.length}`
    });

    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ ok: true }); 
  }
}