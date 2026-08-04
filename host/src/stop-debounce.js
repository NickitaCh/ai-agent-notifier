'use strict';

// Откладывает уведомление на Stop, чтобы не спамить при активной переписке:
// Claude не может начать новый ход без нового сообщения пользователя, так что
// если в течение stopDebounceMs после Stop для той же сессии придёт любое
// новое событие — значит пользователь уже ответил, и отложенное уведомление
// уже неактуально, отменяем его. Если тишина — агент действительно закончил
// и ждёт, шлём.

const timers = new Map(); // sessionId -> Timeout

function cancelPending(sessionId) {
  if (!sessionId) return;
  const timer = timers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(sessionId);
  }
}

// Без sessionId не с чем сверять активность сессии — шлём сразу же.
function scheduleStop(event, delayMs, onFire) {
  if (!event.sessionId) {
    onFire(event);
    return;
  }
  cancelPending(event.sessionId); // на случай пары Stop подряд в одной сессии
  const timer = setTimeout(() => {
    timers.delete(event.sessionId);
    onFire(event);
  }, delayMs);
  timers.set(event.sessionId, timer);
}

module.exports = { cancelPending, scheduleStop };
