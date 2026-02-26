import React, { useState } from 'react';

export default function ImageLightbox({ url, fileName, onClose }) {
    const [scale, setScale] = useState(1);

    if (!url) return null;

    return (
        <div className="lightbox-overlay" onClick={onClose}>
            <div className="lightbox" onClick={e => e.stopPropagation()}>
                <div className="lightbox-header">
                    <span className="lightbox-filename">{fileName}</span>
                    <div className="lightbox-actions">
                        <button className="icon-btn" onClick={() => setScale(s => Math.max(0.25, s - 0.25))}>-</button>
                        <button className="icon-btn" onClick={() => setScale(s => Math.min(4, s + 0.25))}>+</button>
                        <a className="icon-btn" href={url} download={fileName} target="_blank" rel="noreferrer">Download</a>
                        <button className="icon-btn" onClick={onClose}>Close</button>
                    </div>
                </div>
                <div className="lightbox-body">
                    <img src={url} alt={fileName} style={{ transform: `scale(${scale})` }} />
                </div>
            </div>
        </div>
    );
}
