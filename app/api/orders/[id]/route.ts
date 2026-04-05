import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase admin client
function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase environment variables are not configured');
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
    }, // Fixed: added missing }
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const orderId = parseInt(id);
    
    if (isNaN(orderId)) {
      return NextResponse.json({ success: false, error: 'Invalid order ID' }, { status: 400 });
    }
    
    const supabaseAdmin = getSupabaseAdmin();

    // Ensure this is the ONLY declaration of 'order'
    const { data: order, error } = await supabaseAdmin
      .from('sample_orders')
      .select(`
        *,
        clients (*),
        order_styles (*),
        order_files (*)
      `)
      .eq('id', orderId)
      .eq('is_deleted', false)
      .single();

    if (error || !order) {
      return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
    }

    // TRANSFORM: Map the database 'order_files' to the frontend 'files'
    const transformedOrder = {
      ...order,
      client: order.clients,
      styles: order.order_styles || [],
      files: order.order_files || [] // <--- This fix ensures files show up
    };

    return NextResponse.json({ success: true, data: transformedOrder });
  } catch (error: any) {
    console.error('Error fetching order:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const orderId = parseInt(id);
    
    if (isNaN(orderId)) {
      return NextResponse.json({ success: false, error: 'Invalid order ID' }, { status: 400 });
    }
    
    const body = await request.json();
    const supabaseAdmin = getSupabaseAdmin();

    // 1. Handle "Quick Add Style" from the Sidebar
    if (body.add_style) {
      const s = body.add_style;
      const { data, error } = await supabaseAdmin
        .from('order_styles')
        .insert({
          order_id: orderId,
          item_number: s.item_number,
          style_name: s.style_name,
          print_type: s.print_type || 'solid_dyed',
          quantity: s.quantity || 1,
          color_name: s.color_name || null,
          pantone_number: s.pantone_number || null,
          fabric: s.fabric || null,
          notes: s.notes || null,
        })
        .select()
        .single();

      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      
      // Update order timestamp
      await supabaseAdmin.from('sample_orders').update({ updated_at: new Date().toISOString() }).eq('id', orderId);
      return NextResponse.json({ success: true, data });
    }
    
    // 2. Handle "Full Edit" (Updating the whole list of styles)
    if (body.styles && Array.isArray(body.styles)) {
      // DELETE existing styles first
      const { error: delError } = await supabaseAdmin
        .from('order_styles')
        .delete()
        .eq('order_id', orderId);

      if (delError) return NextResponse.json({ success: false, error: 'Failed to clear old styles' }, { status: 500 });

      // Clean the new styles (REMOVE IDs and handle empty strings)
      const cleanedStyles = body.styles.map((s: any) => ({
        order_id: orderId,
        item_number: s.item_number,
        style_name: s.style_name,
        print_type: s.print_type || 'solid_dyed',
        quantity: s.quantity || 1,
        color_name: s.color_name || null,
        pantone_number: s.pantone_number || null,
        fabric: s.fabric || null,
        notes: s.notes || null,
        design_name: s.design_name || null,
        style_number: s.style_number || null
      }));

      const { error: insError } = await supabaseAdmin
        .from('order_styles')
        .insert(cleanedStyles);

      if (insError) return NextResponse.json({ success: false, error: `Insert failed: ${insError.message}` }, { status: 500 });
    }

    // 3. Handle General Order Updates (Priority, Notes, etc.)
    // ADDED: 'production_workflow', 'courier_name', 'tracking_number', 'dispatched_at'
    const allowedUpdates = [
      'status', 
      'notes', 
      'priority', 
      'delivery_date', 
      'sample_type', 
      'assigned_to', 
      'production_workflow',
      'courier_name',
      'tracking_number',
      'dispatched_at'
    ];
    const updates: any = {};

    for (const field of allowedUpdates) {
      if (body[field] !== undefined) {
        // Convert empty strings to null for the database
        updates[field] = body[field] === "" ? null : body[field];
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: orderErr } = await supabaseAdmin
        .from('sample_orders')
        .update(updates)
        .eq('id', orderId);

      if (orderErr) return NextResponse.json({ success: false, error: orderErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Updated successfully' });
  } catch (error: any) {
    console.error('PATCH Error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

// Fixed: Renamed from UPLOAD to POST
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const orderId = parseInt(id);
    const formData = await request.formData();
    const supabaseAdmin = getSupabaseAdmin();
    const uploadedFiles = [];

    for (const [key, value] of formData.entries()) {
      if (key.startsWith('file_')) {
        const file = value as File;
        const filePath = `${orderId}/${Date.now()}-${file.name}`;

        // 1. Upload to Storage
        const { error: storageError } = await supabaseAdmin.storage
          .from('order-files')
          .upload(filePath, file);

        if (storageError) throw storageError;

        // 2. Get Public URL
        const { data: { publicUrl } } = supabaseAdmin.storage
          .from('order-files')
          .getPublicUrl(filePath);

        // 3. CRITICAL: Save record to DATABASE table 'order_files'
        const { data: dbEntry, error: dbError } = await supabaseAdmin
          .from('order_files')
          .insert({
            order_id: orderId,
            file_name: file.name,
            file_url: publicUrl,
            file_type: file.type,
            file_size: file.size
          })
          .select()
          .single();

        if (dbError) {
          console.error("Database entry failed:", dbError);
          throw dbError;
        }
        uploadedFiles.push(dbEntry);
      }
    }

    return NextResponse.json({ success: true, data: uploadedFiles });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const orderId = parseInt(id);
    console.log('DELETE called with raw id:', id, '→ parsed orderId:', orderId);
    if (isNaN(orderId)) {
      return NextResponse.json({ success: false, error: 'Invalid order ID — received: ' + id }, { status: 400 });
    }
    const supabaseAdmin = getSupabaseAdmin();

    const { error } = await supabaseAdmin
      .from('sample_orders')
      .update({
        is_deleted: true, // Fixed comma
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) return NextResponse.json({ success: false, error: 'Delete failed' }, { status: 500 });

    return NextResponse.json({ success: true, message: 'Deleted' });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
  }
}