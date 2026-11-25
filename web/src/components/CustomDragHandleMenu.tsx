import { FC, ReactNode } from 'react';
import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
  BlockColorsItem,
  RemoveBlockItem,
  TableRowHeaderItem,
  TableColumnHeaderItem,
  SideMenu,
  AddBlockButton,
  DragHandleButton,
  SideMenuProps,
} from '@blocknote/react';
import {
  RefreshCw,
  Copy,
  Download,
  CheckSquare,
  Square,
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  ChevronRight,
  Code,
  Quote,
  Smile,
} from 'lucide-react';
import { t } from '../i18n';
import { toast } from '../toast';
import { api, isSafeDownloadUrl } from '../api';

const CONVERTIBLE_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'toggleListItem',
  'quote',
  'callout',
  'codeBlock',
]);

const DOWNLOADABLE_TYPES = new Set(['file', 'image', 'video', 'audio']);

function cloneBlockWithoutIds(b: any): any {
  return {
    type: b.type,
    props: b.props ? structuredClone(b.props) : {},
    content: Array.isArray(b.content) ? structuredClone(b.content) : b.content,
    children: Array.isArray(b.children) ? b.children.map(cloneBlockWithoutIds) : undefined,
  };
}

function flattenInlineContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item?.type === 'pageLink') return String(item.props?.label || '');
      if (typeof item?.text === 'string') return item.text;
      if (Array.isArray(item?.content)) return flattenInlineContent(item.content);
      return '';
    })
    .join('');
}

interface TurnIntoOption {
  id: string;
  label: string;
  type: string;
  props?: Record<string, any>;
  icon: ReactNode;
}

export const CustomDragHandleMenu: FC = () => {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<any, any, any>();

  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });

  if (!block) return null;

  const selectedBlocks = editor.getSelection()?.blocks;
  const targetBlocks =
    selectedBlocks && selectedBlocks.some((b) => b.id === block.id)
      ? selectedBlocks
      : [block];

  const canConvert = targetBlocks.every((b) => CONVERTIBLE_TYPES.has(b.type));
  const isAllChecklist = targetBlocks.every((b) => b.type === 'checkListItem');
  const isCode = block.type === 'codeBlock';
  const blockUrl = typeof (block.props as any)?.url === 'string' ? (block.props as any).url : '';
  const hasDownloadableUrl = DOWNLOADABLE_TYPES.has(block.type) && isSafeDownloadUrl(blockUrl);

  const turnIntoOptions: TurnIntoOption[] = [
    { id: 'paragraph', label: t('Text'), type: 'paragraph', icon: <Type size={15} /> },
    { id: 'h1', label: t('Heading 1'), type: 'heading', props: { level: 1 }, icon: <Heading1 size={15} /> },
    { id: 'h2', label: t('Heading 2'), type: 'heading', props: { level: 2 }, icon: <Heading2 size={15} /> },
    { id: 'h3', label: t('Heading 3'), type: 'heading', props: { level: 3 }, icon: <Heading3 size={15} /> },
    { id: 'bullet', label: t('Bulleted list'), type: 'bulletListItem', icon: <List size={15} /> },
    { id: 'number', label: t('Numbered list'), type: 'numberedListItem', icon: <ListOrdered size={15} /> },
    { id: 'todo', label: t('To-do list'), type: 'checkListItem', icon: <ListTodo size={15} /> },
    { id: 'toggle', label: t('Toggle list'), type: 'toggleListItem', icon: <ChevronRight size={15} /> },
    { id: 'code', label: t('Code block'), type: 'codeBlock', icon: <Code size={15} /> },
    { id: 'quote', label: t('Quote'), type: 'quote', icon: <Quote size={15} /> },
    { id: 'callout', label: t('Callout'), type: 'callout', icon: <Smile size={15} /> },
  ];

  const convertBlocks = (type: string, props?: Record<string, any>) => {
    editor.focus();
    editor.transact(() => {
      for (const b of targetBlocks) {
        const cur = editor.getBlock(b.id);
        if (!cur) continue;
        if (type === 'codeBlock') {
          const plain = flattenInlineContent(cur.content);
          editor.updateBlock(cur, {
            type: 'codeBlock' as any,
            props: (props || {}) as any,
            content: plain ? [{ type: 'text', text: plain, styles: {} }] : [],
          });
        } else {
          editor.updateBlock(cur, {
            type: type as any,
            props: (props || {}) as any,
          });
        }
      }
    });
  };

  const duplicateBlocks = () => {
    const live = targetBlocks.map((b) => editor.getBlock(b.id)).filter(Boolean) as any[];
    if (live.length === 0) return;
    const last = live[live.length - 1];
    editor.insertBlocks(live.map(cloneBlockWithoutIds), last.id, 'after');
    toast.success(t('Block duplicated'));
  };

  const setCheckAll = (checked: boolean) => {
    editor.focus();
    editor.transact(() => {
      const apply = (b: any) => {
        const cur = editor.getBlock(b.id);
        if (!cur) return;
        if (cur.type === 'checkListItem') {
          editor.updateBlock(cur, {
            props: { ...cur.props, checked } as any,
          });
        }
        if (Array.isArray(cur.children)) {
          for (const child of cur.children) apply(child);
        }
      };
      for (const b of targetBlocks) {
        apply(b);
      }
    });
  };

  const copyCode = async () => {
    const cur = editor.getBlock(block.id);
    if (!cur) return;
    const text = flattenInlineContent(cur.content) || (cur.props as any)?.code || '';
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast.success(t('Code copied'));
        return;
      }
    } catch {
      // Fall back to execCommand when Clipboard API is unavailable (e.g. plain HTTP).
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) toast.success(t('Code copied'));
    } catch {
      // Clipboard blocked by browser policy
    }
  };

  const downloadFile = () => {
    const cur = editor.getBlock(block.id);
    if (!cur || !DOWNLOADABLE_TYPES.has(cur.type)) return;
    const url = typeof (cur.props as any)?.url === 'string' ? (cur.props as any).url : '';
    if (isSafeDownloadUrl(url)) {
      api.download(url);
    }
  };

  return (
    <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-drag-handle-menu">
      {/* 1. Turn into > submenu */}
      {canConvert && (
        <Components.Generic.Menu.Root position="right" sub={true}>
          <Components.Generic.Menu.Trigger sub={true}>
            <Components.Generic.Menu.Item
              className="bn-menu-item"
              subTrigger={true}
              icon={<RefreshCw size={15} />}
            >
              {t('Turn into')}
            </Components.Generic.Menu.Item>
          </Components.Generic.Menu.Trigger>
          <Components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown">
            {turnIntoOptions.map((opt) => {
              const isSelected =
                targetBlocks.length === 1 &&
                targetBlocks[0].type === opt.type &&
                (!opt.props ||
                  Object.entries(opt.props).every(([k, v]) => targetBlocks[0].props[k] === v));
              return (
                <Components.Generic.Menu.Item
                  key={opt.id}
                  className="bn-menu-item"
                  icon={opt.icon}
                  checked={isSelected}
                  onClick={() => convertBlocks(opt.type, opt.props)}
                >
                  {opt.label}
                </Components.Generic.Menu.Item>
              );
            })}
          </Components.Generic.Menu.Dropdown>
        </Components.Generic.Menu.Root>
      )}

      {/* 2. Checklist-specific actions */}
      {isAllChecklist && (
        <>
          <Components.Generic.Menu.Item
            className="bn-menu-item"
            icon={<CheckSquare size={15} />}
            onClick={() => setCheckAll(true)}
          >
            {t('Check all')}
          </Components.Generic.Menu.Item>
          <Components.Generic.Menu.Item
            className="bn-menu-item"
            icon={<Square size={15} />}
            onClick={() => setCheckAll(false)}
          >
            {t('Uncheck all')}
          </Components.Generic.Menu.Item>
        </>
      )}

      {/* 3. Codeblock-specific action: Copy code */}
      {isCode && (
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          icon={<Code size={15} />}
          onClick={() => void copyCode()}
        >
          {t('Copy code')}
        </Components.Generic.Menu.Item>
      )}

      {/* 4. File / Image action: Download */}
      {hasDownloadableUrl && (
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          icon={<Download size={15} />}
          onClick={downloadFile}
        >
          {t('Download file')}
        </Components.Generic.Menu.Item>
      )}

      {/* 5. Duplicate */}
      <Components.Generic.Menu.Item
        className="bn-menu-item"
        icon={<Copy size={15} />}
        onClick={duplicateBlocks}
      >
        {t('Duplicate')}
      </Components.Generic.Menu.Item>

      {/* 6. Color picker */}
      <BlockColorsItem>{t('Colors')}</BlockColorsItem>

      {/* 7. Table headers if table */}
      <TableRowHeaderItem>{t('Header row')}</TableRowHeaderItem>
      <TableColumnHeaderItem>{t('Header column')}</TableColumnHeaderItem>

      {/* 8. Delete */}
      <RemoveBlockItem>{t('Delete')}</RemoveBlockItem>
    </Components.Generic.Menu.Dropdown>
  );
};

export const CustomSideMenu: FC<SideMenuProps> = (props) => {
  return (
    <SideMenu {...props}>
      <AddBlockButton />
      <DragHandleButton dragHandleMenu={CustomDragHandleMenu} />
    </SideMenu>
  );
};
