// src/lib/avatarUtils.js
// Helpers for avatar data URL handling: size checks and lightweight compression

/**
 * Approximate byte size of a base64 data URL (without headers)
 */
export function dataUrlSizeBytes(dataUrl) {
    if (!dataUrl || !dataUrl.includes(',')) return 0;
    const base64 = dataUrl.split(',')[1] || '';
    // base64 -> bytes: 3/4 * length, minus padding
    return Math.ceil((base64.length * 3) / 4);
}

/**
 * Compress a data URL image when it exceeds maxBytes. Returns original dataUrl
 * if compression fails or is unnecessary.
 * Uses canvas to downscale and encode to image/webp with decreasing quality.
 */
export async function compressDataUrlIfNeeded(dataUrl, maxBytes = 64 * 1024) {
    try {
        if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl;
        const size = dataUrlSizeBytes(dataUrl);
        if (size <= maxBytes) return dataUrl;

        return await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const MAX_DIM = 512; // limit dimensions to keep output small
                    let w = img.width, h = img.height;
                    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
                    const cw = Math.round(w * scale);
                    const ch = Math.round(h * scale);
                    const canvas = document.createElement('canvas');
                    canvas.width = cw;
                    canvas.height = ch;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, cw, ch);

                    // Try several quality levels until size fits or we hit a low threshold
                    let quality = 0.9;
                    const tryEncode = () => {
                        let out;
                        try {
                            out = canvas.toDataURL('image/webp', quality);
                        } catch (e) {
                            try {
                                out = canvas.toDataURL('image/jpeg', quality);
                            } catch (e2) {
                                return resolve(dataUrl);
                            }
                        }
                        const outSize = dataUrlSizeBytes(out);
                        if (outSize <= maxBytes || quality <= 0.3) {
                            return resolve(out);
                        }
                        quality -= 0.15;
                        setTimeout(tryEncode, 0);
                    };

                    tryEncode();
                } catch (e) {
                    return resolve(dataUrl);
                }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    } catch (e) {
        return dataUrl;
    }
}
