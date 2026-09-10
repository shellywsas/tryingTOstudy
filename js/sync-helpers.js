/* StudyStreak sync helpers — plain JS, browser + node --test */
(function (root) {
    function isAutoHistoryId(id) {
        const s = String(id || "");
        return s.startsWith("ph_auto_") || s.startsWith("ph_refund_");
    }

    function taskLooksCompleted(task, pointsHistory) {
        if (!task) return false;
        if (task.completed || task.givenUp || task.completedAt) return true;
        const hist = pointsHistory || [];
        return hist.some(
            (h) =>
                h.taskId === task.id &&
                h.id &&
                !isAutoHistoryId(h.id)
        );
    }

    function mergeTaskPair(localT, incomingT, pointsHistory) {
        if (!localT) return incomingT;
        if (!incomingT) return localT;
        const localDone = taskLooksCompleted(localT, pointsHistory);
        const incomingDone = taskLooksCompleted(incomingT, pointsHistory);
        if (localDone && !incomingDone) return { ...incomingT, ...localT, completed: true };
        if (incomingDone && !localDone) return { ...localT, ...incomingT, completed: true };
        if (localDone && incomingDone) {
            return { ...localT, ...incomingT, completed: true };
        }
        return { ...localT, ...incomingT };
    }

    function mergeTasks(localTasks, incomingTasks, pointsHistory) {
        const local = Array.isArray(localTasks) ? localTasks : [];
        const incoming = Array.isArray(incomingTasks) ? incomingTasks : [];
        const byId = new Map();
        for (const t of local) {
            if (t && t.id) byId.set(t.id, t);
        }
        for (const t of incoming) {
            if (!t || !t.id) continue;
            byId.set(t.id, mergeTaskPair(byId.get(t.id), t, pointsHistory));
        }
        for (const t of local) {
            if (!t || !t.id) continue;
            if (!incoming.some((x) => x && x.id === t.id)) {
                if (taskLooksCompleted(t, pointsHistory)) {
                    byId.set(t.id, t);
                }
            }
        }
        return Array.from(byId.values());
    }

    function applyRemoteUser(local, remote, tabWrittenSync) {
        if (!remote) return local;
        if (!local) return remote;
        const remoteSync = remote.lastSync || 0;
        const localSync = local.lastSync || 0;
        if (tabWrittenSync && remoteSync && remoteSync <= tabWrittenSync) {
            return local;
        }
        if (!remoteSync && localSync) return local;
        if (remoteSync && localSync && remoteSync < localSync) return local;
        if (remoteSync && localSync && remoteSync === localSync) return local;
        const hist = local.pointsHistory || remote.pointsHistory || [];
        return {
            ...remote,
            tasks: mergeTasks(local.tasks || [], remote.tasks || [], hist),
        };
    }

    function healCompletedFromHistory(user) {
        if (!user || !Array.isArray(user.tasks)) return user;
        const hist = user.pointsHistory || [];
        let changed = false;
        const tasks = user.tasks.map((t) => {
            if (t.completed) return t;
            if (taskLooksCompleted(t, hist)) {
                changed = true;
                return { ...t, completed: true };
            }
            return t;
        });
        return changed ? { ...user, tasks } : user;
    }

    function restoreOnDueEdit(prev, taskId, oldDue, newDue, now) {
        if (!prev || !taskId || !newDue) return prev;
        const nowDate = now instanceof Date ? now : new Date(now || Date.now());
        const newMs = newDue instanceof Date ? newDue.getTime() : new Date(newDue).getTime();
        if (!(newMs > nowDate.getTime())) return prev;

        const tasks = (prev.tasks || []).map((t) =>
            t.id === taskId ? { ...t, autoPenaltyApplied: false } : t
        );
        let totalPoints = prev.totalPoints || 0;
        let weeklyPoints = prev.weeklyPoints || 0;
        let pointsHistory = [...(prev.pointsHistory || [])];
        const alreadyRefunded = pointsHistory.some(
            (h) => h.taskId === taskId && String(h.id || "").startsWith("ph_refund_")
        );
        const autoLogs = pointsHistory.filter(
            (h) =>
                h.taskId === taskId &&
                String(h.id || "").startsWith("ph_auto_") &&
                (h.points || 0) < 0
        );
        if (autoLogs.length && !alreadyRefunded) {
            const refund = autoLogs.reduce((s, h) => s + Math.abs(h.points), 0);
            totalPoints += refund;
            weeklyPoints += refund;
            const sample = autoLogs[0];
            pointsHistory = [
                {
                    id: "ph_refund_" + taskId,
                    taskId: taskId,
                    taskTitle: sample.taskTitle,
                    subjectName: sample.subjectName,
                    subjectEmoji: sample.subjectEmoji,
                    points: refund,
                    date: nowDate.toISOString(),
                    details: "החזר קנס אוטומטי אחרי עדכון תאריך הגשה",
                },
                ...pointsHistory,
            ];
        }

        let streakHistory = [...(prev.streakHistory || [])];
        let taskStreak = prev.taskStreak;
        let currentStreakStart = prev.currentStreakStart;
        let currentStreakEmojis = prev.currentStreakEmojis;
        const idx = streakHistory.findIndex((s) => s.brokenByTaskId === taskId);
        if (idx !== -1 && (taskStreak || 0) === 0) {
            const rec = streakHistory[idx];
            streakHistory.splice(idx, 1);
            taskStreak = rec.length || 0;
            currentStreakStart = rec.startDate;
            currentStreakEmojis = rec.emojis || [];
        }

        return {
            ...prev,
            tasks,
            totalPoints,
            weeklyPoints,
            pointsHistory,
            streakHistory,
            taskStreak,
            currentStreakStart,
            currentStreakEmojis,
        };
    }

    const api = {
        mergeTasks,
        applyRemoteUser,
        healCompletedFromHistory,
        restoreOnDueEdit,
        taskLooksCompleted,
        isAutoHistoryId,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.mergeTasks = mergeTasks;
    root.applyRemoteUser = applyRemoteUser;
    root.healCompletedFromHistory = healCompletedFromHistory;
    root.restoreOnDueEdit = restoreOnDueEdit;
})(typeof globalThis !== "undefined" ? globalThis : this);
