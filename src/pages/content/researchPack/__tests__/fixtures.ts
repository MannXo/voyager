/** DOM fixtures shared by the research-pack content tests. */
import { ADD_BUTTON_CLASS } from '../turnButtons';

export function turn(answerHtml: string, prompt = 'Why is the sky blue?'): HTMLElement {
  const container = document.createElement('div');
  container.className = 'conversation-container';
  container.innerHTML = `
    <user-query><div class="query-text">${prompt}</div></user-query>
    <model-response>
      <div class="response-container">
        <model-thoughts><a href="https://thoughts.example/hidden">thinking</a></model-thoughts>
        <message-content><div class="markdown">${answerHtml}</div></message-content>
        <message-actions>
          <div class="actions-container-v2">
            <div class="buttons-container-v2">
              <button class="copy">Copy</button>
              <a href="https://g.co/share/x">Share</a>
            </div>
          </div>
        </message-actions>
      </div>
    </model-response>`;
  document.body.appendChild(container);
  return container.querySelector('model-response') as HTMLElement;
}

export function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function clickAdd(host: HTMLElement): void {
  const button = host.querySelector<HTMLButtonElement>(`.${ADD_BUTTON_CLASS}`)!;
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  button.click();
}
