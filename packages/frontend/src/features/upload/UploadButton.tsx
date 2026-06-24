import { Upload } from 'lucide-react';
import { uploadDocument } from '../../lib/api';
import type { DocumentItem } from '../../types/document';

const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx';

export function UploadButton({ onUploaded }: { onUploaded: (item: DocumentItem) => void }) {
  return (
    <label className="icon-btn upload-button" title="Upload documents" aria-label="Upload documents">
      <Upload size={18} strokeWidth={1.9} />
      <input
        className="sr-only"
        type="file"
        accept={ACCEPT}
        onChange={async (event) => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = '';
          for (const file of files) {
            try {
              const finalItem = await uploadDocument(file, {
                onOptimistic: onUploaded,
                onFailed: onUploaded
              });
              onUploaded(finalItem);
            } catch (error) {
              console.warn('[normaldocs] upload failed', error);
            }
          }
        }}
        multiple
      />
    </label>
  );
}
