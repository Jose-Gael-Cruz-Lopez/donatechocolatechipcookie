const joinDialog = document.querySelector('#join-dialog');
const form = document.querySelector('#join-form');
const errorMessage = document.querySelector('#form-error');
const submitButton = form.querySelector('button[type="submit"]');
const submitLabel = document.querySelector('#submit-label');
const formView = document.querySelector('#form-view');
const successView = document.querySelector('#success-view');
let lastTrigger = null;
let submitting = false;

// Finish the entrance on interaction, and keep it finished when focus moves.
document.querySelector('.page-shell').addEventListener('focusin', (event) => {
  event.currentTarget.classList.add('entrance-complete');
}, { once: true });

function closeDialog(dialog) {
  dialog.close();
}

document.querySelectorAll('[data-open]').forEach((button) => {
  button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.open);
    const previousDialog = document.querySelector('dialog[open]');
    if (previousDialog) previousDialog.close();
    // An about-sheet link should return focus to the main invitation when closed.
    lastTrigger = button.closest('dialog') ? document.querySelector('.invitation .join-link') : button;
    document.body.classList.add('dialog-open');
    dialog.showModal();
    if (dialog === joinDialog) {
      document.querySelector(formView.hidden ? '#success-title' : '#name').focus();
    }
  });
});

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(dialog));
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(dialog);
  });
  dialog.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) {
      document.body.classList.remove('dialog-open');
      lastTrigger?.focus();
    }
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !form.reportValidity()) return;
  submitting = true;
  errorMessage.hidden = true;
  submitButton.disabled = true;
  submitLabel.textContent = 'one little moment…';
  form.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
      signal: controller.signal,
    });
    let result = null;
    try {
      result = await response.json();
    } catch (parseError) {
      if (parseError.name === 'AbortError') throw parseError;
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error(typeof result?.error === 'string' ? result.error : 'We couldn’t save your details just yet. Please try again.');
    }
    formView.hidden = true;
    successView.hidden = false;
    joinDialog.setAttribute('aria-labelledby', 'success-title');
    joinDialog.removeAttribute('aria-describedby');
    if (joinDialog.open) document.querySelector('#success-title').focus();
    form.reset();
  } catch (error) {
    errorMessage.textContent = error.name === 'AbortError'
      ? 'That took a little too long. Please try again — you won’t be added twice.'
      : error instanceof TypeError
        ? 'We couldn’t connect. Check your connection and try again.'
        : error.message;
    errorMessage.hidden = false;
  } finally {
    clearTimeout(timeout);
    submitting = false;
    submitButton.disabled = false;
    submitLabel.textContent = 'Count me in :p';
    form.removeAttribute('aria-busy');
  }
});
