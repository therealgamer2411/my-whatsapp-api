'use strict';

const { spawn } = require('node:child_process');

let aiPromise;

async function getAi() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }
  if (!aiPromise) {
    aiPromise = import('@google/genai').then(({ GoogleGenAI }) =>
      new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: { apiVersion: 'v1beta' }
      })
    );
  }
  return aiPromise;
}

function normalizeAudioMimeType(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  const supported = new Set([
    'audio/ogg',
    'audio/mp3',
    'audio/mpeg',
    'audio/wav',
    'audio/aiff',
    'audio/aac',
    'audio/flac'
  ]);
  if (!supported.has(mime)) {
    throw new Error('Unsupported audio format: ' + (mime || 'unknown'));
  }
  return mime === 'audio/mpeg' ? 'audio/mp3' : mime;
}

async function transcribeAudio(media) {
  if (!media || !media.data) throw new Error('WhatsApp did not provide audio data.');
  const audio = Buffer.from(media.data, 'base64');
  const maxBytes = Number(process.env.MAX_INCOMING_AUDIO_BYTES || 12 * 1024 * 1024);
  if (!audio.length) throw new Error('Audio message is empty.');
  if (audio.length > maxBytes) {
    throw new Error('Audio message exceeds the configured size limit.');
  }

  const mimeType = normalizeAudioMimeType(media.mimetype || media.mimeType);
  const ai = await getAi();
  const interaction = await ai.interactions.create({
    model: process.env.GEMINI_AUDIO_MODEL || 'gemini-3.6-flash',
    input: [
      {
        type: 'text',
        text: [
          'استمع إلى التسجيل الصوتي التالي واكتب تفريغًا دقيقًا للكلام المنطوق فقط.',
          'التسجيل قد يكون باللهجة المصرية العامية أو العربية الفصحى أو الإنجليزية.',
          'حافظ على اللهجة والمعنى والأسماء والأرقام كما نطقها المتحدث.',
          'لا تلخص ولا تجب عن المتحدث ولا تضف أي تعليق.',
          'إذا كان جزء غير مفهوم، ضع [غير واضح] بدل اختراع كلمات.',
          'أعد النص المفرغ فقط.'
        ].join('\\n')
      },
      {
        type: 'audio',
        data: audio.toString('base64'),
        mime_type: mimeType
      }
    ]
  });

  const transcript = String(interaction.output_text || '').trim();
  if (!transcript || transcript.length < 2) {
    throw new Error('Could not recognize speech in the voice message.');
  }
  return transcript.slice(0, 6000);
}

function wavToOggOpus(wavBuffer) {
  return new Promise((resolve, reject) => {
    let ffmpegPath;
    try {
      ffmpegPath = require('ffmpeg-static');
    } catch (error) {
      return reject(new Error('ffmpeg-static is not installed.'));
    }
    if (!ffmpegPath) return reject(new Error('FFmpeg binary was not found for this platform.'));

    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'wav',
      '-i', 'pipe:0',
      '-map_metadata', '-1',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', process.env.VOICE_BITRATE || '32k',
      '-application', 'voip',
      '-vbr', 'on',
      '-f', 'ogg',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => reject(new Error('FFmpeg failed to start: ' + error.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('FFmpeg audio conversion failed: ' + Buffer.concat(errors).toString('utf8').slice(0, 600)));
      }
      const result = Buffer.concat(output);
      if (result.length < 100 || result.toString('ascii', 0, 4) !== 'OggS') {
        return reject(new Error('FFmpeg did not produce a valid OGG voice note.'));
      }
      resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(wavBuffer);
  });
}

async function synthesizeVoiceNote(text) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Cannot synthesize an empty reply.');
  if (content.length > Number(process.env.MAX_VOICE_REPLY_CHARS || 650)) {
    throw new Error('Reply is too long for automatic voice generation.');
  }

  const ai = await getAi();
  const interaction = await ai.interactions.create({
    model: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: content,
        annotations: [{
          type: 'speech_metadata',
          style: process.env.GEMINI_TTS_STYLE ||
            'Speak in warm, natural Egyptian Arabic (Masri), as a friendly professional office assistant. Conversational rhythm, clear pronunciation, moderate pace, short natural pauses, reassuring and respectful. Do not sound like a formal news announcer.'
        }]
      }]
    }],
    response_format: { type: 'audio' },
    generation_config: {
      speech_config: [
        { voice: process.env.GEMINI_TTS_VOICE || 'Kore' }
      ]
    }
  });

  const encoded = interaction.output_audio && interaction.output_audio.data;
  if (!encoded) throw new Error('The TTS model returned no audio.');
  const wav = Buffer.from(encoded, 'base64');
  if (wav.length < 100) throw new Error('The TTS model returned an empty audio file.');
  return wavToOggOpus(wav);
}

module.exports = { transcribeAudio, synthesizeVoiceNote, normalizeAudioMimeType };
