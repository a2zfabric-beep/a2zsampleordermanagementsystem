import { NextResponse } from 'next/server';
import axios from 'axios';

export async function GET(request: Request) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  // Get your current domain automatically
  const host = request.headers.get('host');
  const protocol = host?.includes('localhost') ? 'http' : 'https';
  const webhookUrl = `${protocol}://${host}/api/integration/telegram`;

  try {
    // Call Telegram API to set the webhook
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`
    );

    return NextResponse.json({
      success: true,
      message: `Webhook registered successfully!`,
      telegram_response: response.data,
      endpoint_linked: webhookUrl
    });
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err.message
    }, { status: 500 });
  }
}