import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createSupabaseDirect } from '@supabase/supabase-js';

interface StyleInput {
  item_number: string;
  style_number: string | null;
  style_name: string;
  print_type: 'solid_dyed' | 'printed';
  color_name: string | null;
  pantone_number: string | null;
  design_name: string | null;
  fabric: string | null;
  quantity: number;
  notes: string | null;
}

interface CreateOrderRequest {
  client_id: number;
  created_by: 'client' | 'admin' | 'automation';
  order_source: 'quick' | 'structured' | 'email';
  delivery_date: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  sample_type: string | null;
  notes: string | null;
  styles: StyleInput[];
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  data?: CreateOrderRequest;
}

function validateCreateOrderRequest(body: any): ValidationResult {
  const errors: string[] = [];

  if (!body.client_id || typeof body.client_id !== 'number') {
    errors.push('client_id is required and must be a number');
  }

  if (!body.styles || !Array.isArray(body.styles) || body.styles.length === 0) {
    errors.push('At least one style is required');
  }

  if (body.styles && Array.isArray(body.styles)) {
    body.styles.forEach((style: any, index: number) => {
      if (!style.item_number || typeof style.item_number !== 'string') {
        errors.push(`Style ${index + 1}: item_number is required`);
      }
      if (!style.style_name || typeof style.style_name !== 'string') {
        errors.push(`Style ${index + 1}: style_name is required`);
      }
      if (!style.print_type || !['solid_dyed', 'printed'].includes(style.print_type)) {
        errors.push(`Style ${index + 1}: print_type must be either "solid_dyed" or "printed"`);
      }
      if (!style.quantity || typeof style.quantity !== 'number' || style.quantity <= 0) {
        errors.push(`Style ${index + 1}: quantity must be a positive number`);
      }

      if (style.print_type === 'solid_dyed') {
        if (style.design_name !== null && style.design_name !== undefined) {
          errors.push(`Style ${index + 1}: design_name must be null for solid_dyed print type`);
        }
      } else if (style.print_type === 'printed') {
        if (style.color_name !== null && style.color_name !== undefined) {
          errors.push(`Style ${index + 1}: color_name must be null for printed print type`);
        }
        if (style.pantone_number !== null && style.pantone_number !== undefined) {
          errors.push(`Style ${index + 1}: pantone_number must be null for printed print type`);
        }
      }
    });
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  const data: CreateOrderRequest = {
    client_id: body.client_id,
    created_by: body.created_by || 'admin',
    order_source: body.order_source || 'structured',
    delivery_date: body.delivery_date || null,
    priority: body.priority || 'medium',
    sample_type: body.sample_type || null,
    notes: body.notes || null,
    styles: body.styles.map((style: any) => ({
      item_number: style.item_number,
      style_number: style.style_number || null,
      style_name: style.style_name,
      print_type: style.print_type,
      color_name: style.color_name || null,
      pantone_number: style.pantone_number || null,
      design_name: style.design_name || null,
      fabric: style.fabric || null,
      quantity: style.quantity,
      notes: style.notes || null,
    })),
  };

  return { isValid: true, errors: [], data };
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase environment variables are not configured');
  }
  return createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
}

async function parseFormData(request: NextRequest) {
  const formData = await request.formData();
  const client_id = formData.get('client_id') as string;
  const created_by = formData.get('created_by') as string || 'admin';
  const order_source = formData.get('order_source') as string || 'structured';
  const priority = formData.get('priority') as string || 'medium';
  const notes = formData.get('notes') as string || '';

  const styles: StyleInput[] = [];
  let styleIndex = 0;

  while (true) {
    const style_name = formData.get(`style_name_${styleIndex}`) as string;
    const item_number = formData.get(`item_number_${styleIndex}`) as string;
    const print_type = formData.get(`print_type_${styleIndex}`) as string || 'solid_dyed';
    const quantity = formData.get(`quantity_${styleIndex}`) as string;
    if (!style_name || !item_number) break;

    styles.push({
      item_number,
      style_number: formData.get(`style_number_${styleIndex}`) as string || null,
      style_name,
      print_type: print_type as 'solid_dyed' | 'printed',
      color_name: formData.get(`color_name_${styleIndex}`) as string || null,
      pantone_number: formData.get(`pantone_number_${styleIndex}`) as string || null,
      design_name: formData.get(`design_name_${styleIndex}`) as string || null,
      fabric: formData.get(`fabric_${styleIndex}`) as string || null,
      quantity: parseInt(quantity),
      notes: formData.get(`notes_${styleIndex}`) as string || null,
    });
    styleIndex++;
  }

  const files: File[] = [];
  let fileIndex = 0;
  while (true) {
    const file = formData.get(`file_${fileIndex}`) as File;
    if (!file) break;
    files.push(file);
    fileIndex++;
  }

  return { client_id: parseInt(client_id), created_by, order_source, priority, notes, styles, files };
}

export async function POST(request: Request) {
  try {
    // 1. Initialize Supabase Direct (Avoids the "Expected 2-3 arguments" error)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabase = createSupabaseDirect(supabaseUrl, supabaseKey);

    const body = await request.json();
    const { client_id, new_client_name, new_client_email, styles } = body;

    let resolvedClientId = client_id;

    if (!client_id) {
      // Auto-create or find client by email
      if (!new_client_name || !new_client_email) {
        return NextResponse.json({ success: false, error: 'Client name and email are required to create a new client.' }, { status: 400 });
      }
      // Check if client already exists by email
      const { data: existing } = await supabase
        .from('clients')
        .select('id')
        .eq('email', new_client_email.trim())
        .single();

      if (existing) {
        resolvedClientId = existing.id;
      } else {
        const { data: newClient, error: createErr } = await supabase
          .from('clients')
          .insert([{ name: new_client_name.trim(), email: new_client_email.trim() }])
          .select()
          .single();
        if (createErr || !newClient) {
          return NextResponse.json({ success: false, error: `Failed to create client: ${createErr?.message}` }, { status: 500 });
        }
        resolvedClientId = newClient.id;
      }
    } else {
      // Verify existing client
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .select('id')
        .eq('id', client_id)
        .single();
      if (clientError || !client) {
        return NextResponse.json({ success: false, error: `Client ID ${client_id} not found.` }, { status: 404 });
      }
    }

    // 3. CREATE THE MAIN ORDER
    const { data: order, error: orderError } = await supabase
      .from('sample_orders')
      .insert([{
        client_id: resolvedClientId,
        status: 'draft',
        order_id: `ORD-${Math.floor(1000 + Math.random() * 10000)}`,
        priority: 'medium',
        created_by: 'admin',
        order_source: 'structured',
        
        // FIX: Capture the delivery date from the request body
        delivery_date: body.delivery_date || null 
      }])
      .select()
      .single();

    if (orderError) throw orderError;

    // 4. CREATE THE STYLES
    if (styles && styles.length > 0) {
      const stylesToInsert = styles.map((s: any) => ({
        order_id: order.id,
        style_name: s.style_name,
        item_number: s.item_number,
        fabric: s.fabric,
        color_name: s.color_name,
        quantity: s.quantity,
        print_type: s.print_type || 'solid_dyed'
      }));

      const { error: stylesError } = await supabase
        .from('order_styles')
        .insert(stylesToInsert);

      if (stylesError) console.error('Styles Error:', stylesError);
    }

    return NextResponse.json({ success: true, data: order });

  } catch (err: any) {
    console.error('Final API Error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data: orders, error } = await supabaseAdmin
      .from('sample_orders')
      .select('*, clients(name, email), order_styles(id)')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

    // REPLACE WITH:
    const transformed = orders.map(o => ({
      id: o.id,
      order_id: o.order_id,
      client_name: o.clients?.name || '',
      style_count: o.order_styles?.length || 0,
      status: o.status,
      created_at: o.created_at,
      delivery_date: o.delivery_date || null,
      dispatched_at: o.dispatched_at || null,
      production_workflow: o.production_workflow || null,
    }));

    return NextResponse.json({ success: true, data: transformed });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Internal Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: "Order ID is required" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin(); // use SERVICE_ROLE_KEY, not ANON_KEY

    const { error } = await supabaseAdmin
      .from('sample_orders')
      .update({ is_deleted: true, updated_at: new Date().toISOString() })
      .eq('id', parseInt(id));

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}