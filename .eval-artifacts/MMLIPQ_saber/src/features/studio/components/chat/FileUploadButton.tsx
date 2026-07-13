import React, { useRef, useCallback } from 'react';
import { Paperclip } from 'lucide-react';
import { Tooltip } from '@arco-design/web-react';
import styles from './FileUpload.module.css';

interface FileUploadButtonProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  maxSize?: number; // in bytes
  disabled?: boolean;
}

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

function FileUploadButton({
  onFilesSelected,
  accept = 'image/*,video/*,.doc,.docx,.ppt,.pptx,.pdf,.txt',
  multiple = true,
  maxSize = DEFAULT_MAX_SIZE,
  disabled = false,
}: FileUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.click();
    }
  }, [disabled]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      const validFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i].size <= maxSize) {
          validFiles.push(files[i]);
        }
      }

      if (validFiles.length > 0) {
        onFilesSelected(validFiles);
      }

      event.target.value = '';
    },
    [onFilesSelected, maxSize],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      <Tooltip content="上传附件">
        <button
          className={styles.uploadBtn}
          onClick={handleClick}
          disabled={disabled}
          type="button"
        >
          <Paperclip size={18} />
        </button>
      </Tooltip>
    </>
  );
}

export default FileUploadButton;
