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

    function isTaskSubmittedOnTime(task) {
        if (!task || !task.completedAt || !task.dueDate) return false;
        const subDate = new Date(task.completedAt);
        const timeStr = task.dueTime || '23:59:59';
        const dueDate = new Date(`${task.dueDate}T${timeStr}`);
        if (isNaN(subDate.getTime()) || isNaN(dueDate.getTime())) return false;
        // 5 minutes grace period for clock differences or submitting at the exact minute
        return subDate.getTime() <= (dueDate.getTime() + (5 * 60 * 1000));
    }

    function mergeTaskPair(localT, incomingT, pointsHistory) {
        if (!localT) {
            return taskLooksCompleted(incomingT, pointsHistory)
                ? { ...incomingT, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(incomingT) ? false : (incomingT.autoPenaltyApplied || false) }
                : incomingT;
        }
        if (!incomingT) {
            return taskLooksCompleted(localT, pointsHistory)
                ? { ...localT, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(localT) ? false : (localT.autoPenaltyApplied || false) }
                : localT;
        }
        const localDone = taskLooksCompleted(localT, pointsHistory);
        const incomingDone = taskLooksCompleted(incomingT, pointsHistory);
        if (localDone && !incomingDone) return { ...incomingT, ...localT, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(localT) ? false : (localT.autoPenaltyApplied || false) };
        if (incomingDone && !localDone) return { ...localT, ...incomingT, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(incomingT) ? false : (incomingT.autoPenaltyApplied || false) };
        if (localDone && incomingDone) {
            const preferLocal = (localT.pointsEarned || 0) >= (incomingT.pointsEarned || 0);
            const base = preferLocal ? { ...incomingT, ...localT } : { ...localT, ...incomingT };
            const onTime = isTaskSubmittedOnTime(base) || isTaskSubmittedOnTime(localT) || isTaskSubmittedOnTime(incomingT);
            return {
                ...base,
                completed: true,
                autoPenaltyApplied: onTime ? false : (base.autoPenaltyApplied || false)
            };
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

    function getLastSaturday22PM(now) {
        const nowDate = now instanceof Date ? now : new Date(now || Date.now());
        const d = nowDate.getDay(); // 0 = Sun, ..., 6 = Sat
        const target = new Date(nowDate);
        if (d === 6) {
            if (nowDate.getHours() < 22) {
                target.setDate(nowDate.getDate() - 7);
                target.setHours(22, 0, 0, 0);
                return target.getTime();
            } else {
                target.setHours(22, 0, 0, 0);
                return target.getTime();
            }
        }
        const daysBack = d + 1;
        target.setDate(nowDate.getDate() - daysBack);
        target.setHours(22, 0, 0, 0);
        return target.getTime();
    }

    function normalizeBadge(b) {
        if (!b) return null;
        if (typeof b === 'string') return { id: b, earnedAt: new Date().toISOString() };
        if (b && b.id) return b;
        return null;
    }

    function mergeBadges(localBadges, remoteBadges) {
        const listA = (Array.isArray(localBadges) ? localBadges : []).map(normalizeBadge).filter(Boolean);
        const listB = (Array.isArray(remoteBadges) ? remoteBadges : []).map(normalizeBadge).filter(Boolean);
        const map = new Map();
        [...listB, ...listA].forEach(b => {
            const existing = map.get(b.id);
            if (!existing) {
                map.set(b.id, b);
            } else {
                map.set(b.id, {
                    ...existing,
                    ...b,
                    count: Math.max(existing.count || 1, b.count || 1)
                });
            }
        });
        return Array.from(map.values());
    }

    function applyRemoteUser(local, remote, tabWrittenSync) {
        if (!remote) return local;
        if (!local) return remote;
        const remoteSync = remote.lastSync || 0;
        const localSync = local.lastSync || 0;
        const mergedBadges = mergeBadges(local.badges, remote.badges);

        if (tabWrittenSync && remoteSync && remoteSync <= tabWrittenSync) {
            return { ...local, badges: mergedBadges };
        }
        if (!remoteSync && localSync) return { ...local, badges: mergedBadges };
        if (remoteSync && localSync && remoteSync < localSync) return { ...local, badges: mergedBadges };
        if (remoteSync && localSync && remoteSync === localSync) return { ...local, badges: mergedBadges };
        const hist = local.pointsHistory || remote.pointsHistory || [];
        return {
            ...remote,
            badges: mergedBadges,
            tasks: mergeTasks(local.tasks || [], remote.tasks || [], hist),
        };
    }

    function healCompletedFromHistory(user) {
        if (!user || !Array.isArray(user.tasks)) return user;
        const hist = [...(user.pointsHistory || [])];
        let changed = false;
        let totalPoints = user.totalPoints || 0;
        let weeklyPoints = user.weeklyPoints || 0;
        let taskStreak = user.taskStreak;
        let streakHistory = [...(user.streakHistory || [])];
        let newHist = [...hist];
        const weekStart = getLastSaturday22PM();

        const tasks = user.tasks.map((t) => {
            if (!t) return t;
            const isDone = taskLooksCompleted(t, hist);
            const onTime = isTaskSubmittedOnTime(t);
            let updated = { ...t };

            if (isDone && !updated.completed) {
                updated.completed = true;
                changed = true;
            }

            if (onTime || (updated.completed && updated.completedAt)) {
                const subDate = new Date(updated.completedAt);
                const timeStr = updated.dueTime || '23:59:59';
                const dueDate = updated.dueDate ? new Date(`${updated.dueDate}T${timeStr}`) : null;
                const wasActuallyOnTime = onTime || (dueDate && !isNaN(dueDate.getTime()) && subDate.getTime() <= (dueDate.getTime() + (5 * 60 * 1000)));

                if (wasActuallyOnTime) {
                    if (updated.autoPenaltyApplied) {
                        updated.autoPenaltyApplied = false;
                        changed = true;
                    }
                    if (updated.lateReason) {
                        delete updated.lateReason;
                        changed = true;
                    }

                    if ((updated.pointsEarned === undefined || updated.pointsEarned <= 0) && !updated.givenUp) {
                        const createdAt = updated.createdAt ? new Date(updated.createdAt) : null;
                        let points = 1;
                        if (dueDate && createdAt && !isNaN(dueDate.getTime()) && !isNaN(createdAt.getTime())) {
                            const totalMs = dueDate.getTime() - createdAt.getTime();
                            const usedMs = subDate.getTime() - createdAt.getTime();
                            if (usedMs <= Math.max(totalMs / 2, 86400000)) points = 2;
                        }
                        if (updated.isExamPrep) points += 1;
                        const delta = points - (updated.pointsEarned || 0);
                        if (delta > 0) {
                            totalPoints += delta;
                            if (subDate.getTime() >= weekStart) {
                                weeklyPoints += delta;
                            }
                            updated.pointsEarned = points;
                            changed = true;
                        }
                    }

                    const autoPenaltyLogs = newHist.filter(h => h && h.taskId === updated.id && isAutoHistoryId(h.id) && (h.points || 0) < 0);
                    if (autoPenaltyLogs.length > 0) {
                        const refundedPoints = autoPenaltyLogs.reduce((sum, h) => sum + Math.abs(h.points || 0), 0);
                        totalPoints += refundedPoints;
                        const newestLogTime = Math.max(...autoPenaltyLogs.map(h => h.date ? new Date(h.date).getTime() : 0));
                        if (newestLogTime >= weekStart) {
                            weeklyPoints += refundedPoints;
                        }
                        newHist = newHist.filter(h => !(h && h.taskId === updated.id && isAutoHistoryId(h.id) && (h.points || 0) < 0));
                        changed = true;
                    }

                    // Find if streak was broken by this task
                    let brokenIdx = streakHistory.findIndex(s => s && s.brokenByTaskId === updated.id);
                    if (brokenIdx === -1 && autoPenaltyLogs.length > 0 && dueDate) {
                        brokenIdx = streakHistory.findIndex(s => s && s.endDate && Math.abs(new Date(s.endDate).getTime() - dueDate.getTime()) < 60000);
                    }
                    if (brokenIdx === -1 && autoPenaltyLogs.length > 0 && streakHistory.length > 0 && (taskStreak === 0 || taskStreak === undefined)) {
                        const lastLog = autoPenaltyLogs[autoPenaltyLogs.length - 1];
                        const logTime = lastLog.date ? new Date(lastLog.date).getTime() : 0;
                        const lastStreak = streakHistory[streakHistory.length - 1];
                        const streakTime = lastStreak.id && lastStreak.id.startsWith('sh_') ? parseInt(lastStreak.id.replace('sh_', '')) : 0;
                        if (logTime && streakTime && Math.abs(logTime - streakTime) < 5 * 60 * 1000) {
                            brokenIdx = streakHistory.length - 1;
                        }
                    }

                    if (brokenIdx !== -1) {
                        const brokenRecord = streakHistory[brokenIdx];
                        streakHistory.splice(brokenIdx, 1);
                        taskStreak = (brokenRecord.length || 0) + (taskStreak && taskStreak > 0 ? taskStreak : 1);
                        changed = true;
                    }
                }
            }

            return updated;
        });

        // Self-healing: if user has weeklyPoints > 0 but has not completed tasks or earned positive points this week, heal to 0!
        const hasPositiveActivityThisWeek = tasks.some(t => {
            if (!t || !t.completed || !t.completedAt) return false;
            const tTime = new Date(t.completedAt).getTime();
            return !isNaN(tTime) && tTime >= weekStart;
        }) || newHist.some(h => {
            if (!h || !h.date || h.canceled || (h.points || 0) <= 0) return false;
            const hTime = new Date(h.date).getTime();
            return !isNaN(hTime) && hTime >= weekStart;
        });

        if (!hasPositiveActivityThisWeek && weeklyPoints > 0) {
            weeklyPoints = 0;
            changed = true;
        }

        if (!changed) return user;

        return {
            ...user,
            tasks,
            totalPoints,
            weeklyPoints,
            pointsHistory: newHist,
            taskStreak: taskStreak !== undefined ? taskStreak : (user.taskStreak || 0),
            streakHistory
        };
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
            const sample = autoLogs[0];
            const sampleTime = sample && sample.date ? new Date(sample.date).getTime() : nowDate.getTime();
            if (sampleTime >= getLastSaturday22PM(nowDate)) {
                weeklyPoints += refund;
            }
            pointsHistory = [
                {
                    id: "ph_refund_" + taskId,
                    taskId: taskId,
                    taskTitle: sample ? sample.taskTitle : "",
                    subjectName: sample ? sample.subjectName : "",
                    subjectEmoji: sample ? sample.subjectEmoji : "",
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
            taskStreak: taskStreak ?? (prev.taskStreak || 0),
            currentStreakStart: currentStreakStart !== undefined ? currentStreakStart : (prev.currentStreakStart || null),
            currentStreakEmojis: currentStreakEmojis !== undefined ? currentStreakEmojis : (prev.currentStreakEmojis || []),
        };
    }

    const api = {
        mergeTasks,
        applyRemoteUser,
        healCompletedFromHistory,
        restoreOnDueEdit,
        taskLooksCompleted,
        isTaskSubmittedOnTime,
        isAutoHistoryId,
        getLastSaturday22PM,
        normalizeBadge,
        mergeBadges,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.mergeTasks = mergeTasks;
    root.applyRemoteUser = applyRemoteUser;
    root.healCompletedFromHistory = healCompletedFromHistory;
    root.restoreOnDueEdit = restoreOnDueEdit;
    root.taskLooksCompleted = taskLooksCompleted;
    root.isTaskSubmittedOnTime = isTaskSubmittedOnTime;
    root.getLastSaturday22PM = getLastSaturday22PM;
    root.normalizeBadge = normalizeBadge;
    root.mergeBadges = mergeBadges;
})(typeof globalThis !== "undefined" ? globalThis : this);
