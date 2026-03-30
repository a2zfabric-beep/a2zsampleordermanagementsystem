import { createClient as createSupabaseDirect } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import axios from 'axios';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID; 

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseDirect(supabaseUrl, supabaseKey);
    const body = await request.json();

    const userId = body.message?.from?.id?.toString();
    if (userId !== ALLOWED_USER_ID) return NextResponse.json({ ok: true });

    // --- ADD THIS: Reply to text messages like "Hi" ---
    const text = body.message?.text;
    if (text) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: userId,
            text: "Hello! I am alive. Please send me an Excel file to create an order."
        });
        return NextResponse.json({ ok: true });
    }
    // -------------------------------------------------

    const document = body.message?.document;
    // ... rest of code
    const document = body.message?.document;
    if (!document) return NextResponse.json({ ok: true });

    // 1. Get File from Telegram
    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${document.file_id}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    // 2. Parse Excel
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const workbook = XLSX.read(response.data, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) throw new Error("Excel sheet is empty.");

    // 3. Extract Client Info (from first row)
    const firstRow = rows[0];
    const clientEmail = firstRow.client_email?.trim().toLowerCase();
    const clientName = firstRow.client_name || 'New Client';
    
    if (!clientEmail) throw new Error("Column 'client_email' is missing in the first row.");

    // 4. Find or Create Client
    let { data: client } = await supabase.from('clients').select('id').eq('email', clientEmail).single();
    
    if (!client) {
        const { data: newClient, error: cErr } = await supabase
            .from('clients')
            .insert([{ name: clientName, email: clientEmail }])
            .select().single();
        if (cErr) throw cErr;
        client = newClient;
    }

    // 5. Create THE Order (One order for all rows)
    const deliveryDate = firstRow.delivery_date 
        ? new Date(firstRow.delivery_date) 
        : new Date(Date.now() + 21 * 86400000); // Default 21 days lead time

    const { data: order, error: orderErr } = await supabase
      .from('sample_orders')
      .insert([{
        client_id: client?.id,
        order_id: `TG-${Math.floor(1000 + Math.random() * 9000)}`,
        status: 'in_review',
        delivery_date: deliveryDate.toISOString(),
        created_by: 'automation',
        order_source: 'email',
        priority: firstRow.priority?.toLowerCase() || 'medium',
        notes: "Uploaded via Telegram Excel Bot"
      }])
      .select().single();

    if (orderErr) throw orderErr;

    // 6. Map Multiple Styles with Smart Item Numbers
    const nameParts = clientName.split(' ');
    const initials = nameParts.length > 1 
      ? (nameParts[0].substring(0, 2) + nameParts[1].substring(0, 2)).toUpperCase()
      : clientName.substring(0, 4).toUpperCase();

    const stylesToInsert = rows.map((row, index) => ({
      order_id: order.id,
      // Logic: Use provided item_number, or generate "JODO-1001"
      item_number: row.item_number || `${initials}-${1000 + index + 1}`,
      style_name: row.style_name || 'General Clothing',
      fabric: row.fabric || 'TBD',
      color_name: row.color || 'TBD',
      quantity: Number(row.quantity) || 1,
      print_type: row.type?.toLowerCase().includes('print') ? 'printed' : 'solid_dyed'
    }));

    const { error: styleErr } = await supabase.from('order_styles').insert(stylesToInsert);
    if (styleErr) throw styleErr;

    // 7. Success Message
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: userId,
        text: `✅ **Order Created Successfully**\n\nOrder ID: \`${order.order_id}\`\nClient: ${clientName}\nStyles Added: ${stylesToInsert.length}\nTarget Date: ${deliveryDate.toLocaleDateString()}`
    });

    return NextResponse.json({ ok: true });

  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ ok: true }); // Telegram needs 200 OK even on fail to stop retrying
  }
}