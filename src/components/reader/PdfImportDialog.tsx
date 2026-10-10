"use client";

import { FileText, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

type PdfImportDialogProps = {
  open: boolean;
  fileName: string;
  status: string;
  onCancel: () => void;
};

export function PdfImportDialog({ open, fileName, status, onCancel }: PdfImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = globalThis.document.activeElement;
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      // Successful import removes the input; cancellation enables it again.
      queueMicrotask(() => {
        const target = previousFocus instanceof HTMLElement && previousFocus.isConnected
          && !previousFocus.hasAttribute("disabled") ? previousFocus
          : globalThis.document.querySelector<HTMLElement>(".source-navigation button");
        target?.focus({ preventScroll: true });
      });
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="pdf-import-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-import-title"
      aria-describedby="pdf-import-description pdf-import-fidelity"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <div className="pdf-import-icon" aria-hidden="true"><FileText size={28} /></div>
      <h2 id="pdf-import-title" ref={titleRef} tabIndex={-1}>Preparando tu PDF</h2>
      <p className="pdf-import-file" title={fileName}>{fileName}</p>
      <p id="pdf-import-description">Identificamos títulos, subtítulos, párrafos y viñetas para reorganizar el texto y adaptarlo a En voz.</p>
      <p id="pdf-import-fidelity" className="pdf-import-fidelity">El resultado puede tener diferencias de formato u organización respecto del PDF original. Revisa el contenido, especialmente tablas, nombres y cifras.</p>
      <div className="pdf-import-status" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle size={19} aria-hidden="true" /><span>{status}</span>
      </div>
      <progress className="pdf-import-progress" aria-label="Procesamiento del PDF" aria-busy={open} />
      <button type="button" className="pdf-import-cancel" onClick={onCancel}>Cancelar importación</button>
    </dialog>
  );
}
