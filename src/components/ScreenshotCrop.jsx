// src/components/ScreenshotCrop.jsx
// Fullscreen crop overlay — user drags to select a region of a captured screenshot

import React, { useState, useRef, useCallback, useEffect } from 'react';

export default function ScreenshotCrop({ imageDataUrl, onCrop, onCancel, isLoading = false }) {
    const canvasRef = useRef(null);
    const [dragging, setDragging] = useState(false);
    const [start, setStart] = useState({ x: 0, y: 0 });
    const [end, setEnd] = useState({ x: 0, y: 0 });
    const [imgLoaded, setImgLoaded] = useState(false);
    const imgRef = useRef(null);

    // load image into hidden element
    useEffect(() => {
        const img = new Image();
        img.onload = () => { imgRef.current = img; setImgLoaded(true); };
        img.src = imageDataUrl;
    }, [imageDataUrl]);

    const getRect = () => {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        return { x, y, w, h };
    };

    const handleMouseDown = useCallback((e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setStart(pos);
        setEnd(pos);
        setDragging(true);
    }, []);

    const handleMouseMove = useCallback((e) => {
        if (!dragging) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, [dragging]);

    const handleMouseUp = useCallback(() => {
        setDragging(false);
    }, []);

    const handleConfirm = useCallback(() => {
        if (!imgRef.current) return;
        const container = canvasRef.current;
        if (!container) return;
        const { x, y, w, h } = getRect();
        if (w < 10 || h < 10) { onCancel(); return; }

        // Map overlay coordinates to actual image coordinates
        const contRect = container.getBoundingClientRect();
        const scaleX = imgRef.current.naturalWidth / contRect.width;
        const scaleY = imgRef.current.naturalHeight / contRect.height;

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scaleX);
        canvas.height = Math.round(h * scaleY);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(
            imgRef.current,
            Math.round(x * scaleX), Math.round(y * scaleY),
            canvas.width, canvas.height,
            0, 0, canvas.width, canvas.height
        );
        onCrop(canvas.toDataURL('image/png'));
    }, [start, end, onCrop, onCancel]);

    const handleFullCapture = useCallback(() => {
        onCrop(imageDataUrl);
    }, [imageDataUrl, onCrop]);

    const sel = getRect();

    return (
        <div className="crop-overlay">
            <div
                ref={canvasRef}
                className="crop-image-container"
                onMouseDown={!isLoading ? handleMouseDown : undefined}
                onMouseMove={!isLoading ? handleMouseMove : undefined}
                onMouseUp={!isLoading ? handleMouseUp : undefined}
                style={{
                    backgroundImage: imageDataUrl ? `url(${imageDataUrl})` : 'none',
                    backgroundSize: 'contain',
                    backgroundPosition: 'center',
                    backgroundColor: '#000'
                }}
            >
                {isLoading && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexDirection: 'column',
                        gap: '16px'
                    }}>
                        <div style={{
                            width: '40px',
                            height: '40px',
                            border: '3px solid rgba(255,255,255,0.3)',
                            borderTop: '3px solid white',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                        }} />
                        <p style={{ color: '#94a3b8', fontSize: '14px' }}>Capturing screen...</p>
                    </div>
                )}
                {/* dim mask with cutout */}
                {!isLoading && (sel.w > 5 && sel.h > 5) && (
                    <div className="crop-selection" style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
                )}
            </div>
            <div className="crop-toolbar">
                <span className="crop-hint">{isLoading ? 'Please wait...' : 'Drag to select area'}</span>
                <div className="crop-actions">
                    <button className="btn-secondary btn-sm" onClick={onCancel} disabled={isLoading}>Cancel</button>
                    <button className="btn-secondary btn-sm" onClick={handleFullCapture} disabled={isLoading || !imageDataUrl}>Full Screen</button>
                    <button className="btn-primary btn-sm" onClick={handleConfirm} disabled={sel.w < 10 || sel.h < 10 || isLoading || !imageDataUrl}>
                        Crop & Send
                    </button>
                </div>
            </div>
        </div>
    );
}
