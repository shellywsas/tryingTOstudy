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
        if (!task || !task.completedAt) return false;
        // Practice sessions and flexible sessions have no fixed deadline and are always on-time
        if (task.isPracticeSession || task.isFlexibleExamSession || !task.dueDate) return true;
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
        const localMod = localT.updatedAt || localT.lastModified || localT.createdAt || 0;
        const incomingMod = incomingT.updatedAt || incomingT.lastModified || incomingT.createdAt || 0;
        return incomingMod >= localMod ? { ...localT, ...incomingT } : { ...incomingT, ...localT };
    }

    function mergeExams(localExams, remoteExams) {
        const local = Array.isArray(localExams) ? localExams : [];
        const remote = Array.isArray(remoteExams) ? remoteExams : [];
        const byId = new Map();
        for (const e of remote) {
            if (e && e.id) byId.set(e.id, e);
        }
        for (const e of local) {
            if (!e || !e.id) continue;
            if (!byId.has(e.id)) {
                byId.set(e.id, e);
            } else {
                const r = byId.get(e.id);
                const localUpdated = e.updatedAt || e.lastModified || 0;
                const remoteUpdated = r.updatedAt || r.lastModified || 0;
                byId.set(e.id, localUpdated >= remoteUpdated ? { ...r, ...e } : { ...e, ...r });
            }
        }
        return Array.from(byId.values());
    }

    function mergeTasks(localTasks, incomingTasks, pointsHistory, deletedTaskIds = []) {
        const deletedSet = new Set(Array.isArray(deletedTaskIds) ? deletedTaskIds : []);
        const local = (Array.isArray(localTasks) ? localTasks : []).filter(t => t && t.id && !deletedSet.has(t.id));
        const incoming = (Array.isArray(incomingTasks) ? incomingTasks : []).filter(t => t && t.id && !deletedSet.has(t.id));
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
            if (!byId.has(t.id)) {
                byId.set(t.id, t);
            }
        }
        return Array.from(byId.values());
    }

    function getCurrentWeekStart(now) {
        const nowDate = now instanceof Date ? now : new Date(now || Date.now());
        const d = nowDate.getDay(); // 0 = Sun, ..., 6 = Sat
        const sunday = new Date(nowDate);
        sunday.setDate(nowDate.getDate() - d);
        sunday.setHours(0, 0, 0, 0);
        return sunday.getTime();
    }

    function getNextWeekReset(now) {
        const weekStart = getCurrentWeekStart(now);
        const nextSunday = new Date(weekStart);
        nextSunday.setDate(nextSunday.getDate() + 7);
        nextSunday.setHours(0, 0, 0, 0);
        return nextSunday.getTime();
    }

    function getLastSaturday22PM(now) {
        return getCurrentWeekStart(now);
    }

    function getEffectiveWeeklyPoints(userData, nowInput) {
        if (!userData) return 0;
        const now = typeof nowInput === 'number' ? nowInput : (nowInput instanceof Date ? nowInput.getTime() : Date.now());
        const weekStart = getCurrentWeekStart(now);
        
        const hist = Array.isArray(userData.pointsHistory) ? userData.pointsHistory : [];
        const histSum = hist.filter(h => {
            if (!h || !h.date || h.canceled || (h.points || 0) <= 0) return false;
            const t = new Date(h.date).getTime();
            return !isNaN(t) && t >= weekStart && t <= now;
        }).reduce((sum, h) => sum + (h.points || 0), 0);
        
        const tasks = Array.isArray(userData.tasks) ? userData.tasks : [];
        const taskSum = tasks.filter(t => {
            if (!t || !t.completed || !t.completedAt || t.givenUp) return false;
            const tTime = new Date(t.completedAt).getTime();
            return !isNaN(tTime) && tTime >= weekStart && tTime <= now;
        }).reduce((sum, t) => sum + (t.pointsEarned || 1), 0);
        
        const actualThisWeek = Math.max(histSum, taskSum);
        if (actualThisWeek === 0) {
            return 0;
        }
        return actualThisWeek;
    }

    function normalizeBadge(b) {
        if (!b) return null;
        if (typeof b === 'string') return { id: b, earnedAt: new Date().toISOString() };
        if (b && b.id) return b;
        return null;
    }

    function mergeBadges(localBadges, remoteBadges, local, remote) {
        const listA = (Array.isArray(localBadges) ? localBadges : []).map(normalizeBadge).filter(Boolean);
        const listB = (Array.isArray(remoteBadges) ? remoteBadges : []).map(normalizeBadge).filter(Boolean);
        const map = new Map();
        [...listB, ...listA].forEach(b => {
            const existing = map.get(b.id);
            if (!existing) {
                map.set(b.id, b);
            } else {
                if (b.id === 'b_weekly_champ') {
                    const wA = Array.isArray(existing.wonWeeks) ? existing.wonWeeks : [];
                    const wB = Array.isArray(b.wonWeeks) ? b.wonWeeks : [];
                    let mergedWeeks = Array.from(new Set([...wA, ...wB]));
                    const hasLocal = typeof local !== 'undefined' && local;
                    const hasRemote = typeof remote !== 'undefined' && remote;
                    const isUserShely = (hasLocal && (local.username === 'שליי' || local.name === 'שלי')) || 
                                        (hasRemote && (remote.username === 'שליי' || remote.name === 'שלי'));
                    if (isUserShely) {
                        mergedWeeks = mergedWeeks.filter(w => w !== '2026-W45');
                    }
                    const safeCount = mergedWeeks.length > 0 ? mergedWeeks.length : Math.max(existing.count || 1, b.count || 1);
                    map.set(b.id, {
                        ...existing,
                        ...b,
                        wonWeeks: mergedWeeks,
                        count: safeCount,
                        lastWonWeek: mergedWeeks.length > 0 ? mergedWeeks[mergedWeeks.length - 1] : (b.lastWonWeek || existing.lastWonWeek)
                    });
                } else {
                    map.set(b.id, {
                        ...existing,
                        ...b,
                        count: Math.max(existing.count || 1, b.count || 1)
                    });
                }
            }
        });
        return Array.from(map.values());
    }

    const OUTBOX_KEY_PREFIX = 'studyStreak_outbox_';

    function markPendingSync(username, data) {
        if (!username || typeof localStorage === 'undefined') return;
        try {
            const outboxItem = {
                username,
                timestamp: Date.now(),
                data: data
            };
            localStorage.setItem(OUTBOX_KEY_PREFIX + username, JSON.stringify(outboxItem));
        } catch (e) {
            console.warn('Could not write to sync outbox:', e);
        }
    }

    function getPendingSync(username) {
        if (!username || typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(OUTBOX_KEY_PREFIX + username);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function clearPendingSync(username) {
        if (!username || typeof localStorage === 'undefined') return;
        try {
            localStorage.removeItem(OUTBOX_KEY_PREFIX + username);
        } catch (e) {}
    }

    function mergePointsHistory(localHist, remoteHist) {
        const listA = Array.isArray(localHist) ? localHist : [];
        const listB = Array.isArray(remoteHist) ? remoteHist : [];
        const map = new Map();
        for (const item of [...listB, ...listA]) {
            if (!item) continue;
            const key = item.id ? String(item.id) : (item.taskId && item.date ? `${item.taskId}_${item.date}` : null);
            if (!key) continue;
            if (!map.has(key)) {
                map.set(key, item);
            } else {
                const existing = map.get(key);
                map.set(key, { ...existing, ...item });
            }
        }
        const merged = Array.from(map.values());
        merged.sort((a, b) => {
            const timeA = a.date ? new Date(a.date).getTime() : 0;
            const timeB = b.date ? new Date(b.date).getTime() : 0;
            return timeB - timeA;
        });
        return merged;
    }

    function mergeStreakHistory(localStreaks, remoteStreaks) {
        const listA = Array.isArray(localStreaks) ? localStreaks : [];
        const listB = Array.isArray(remoteStreaks) ? remoteStreaks : [];
        const map = new Map();
        for (const item of [...listB, ...listA]) {
            if (!item) continue;
            const key = item.id ? String(item.id) : (item.startDate && item.endDate ? `${item.startDate}_${item.endDate}` : null);
            if (!key) continue;
            if (!map.has(key)) {
                map.set(key, item);
            } else {
                const existing = map.get(key);
                map.set(key, { ...existing, ...item });
            }
        }
        const merged = Array.from(map.values());
        merged.sort((a, b) => {
            const timeA = a.endDate ? new Date(a.endDate).getTime() : 0;
            const timeB = b.endDate ? new Date(b.endDate).getTime() : 0;
            return timeB - timeA;
        });
        return merged;
    }

    function verifyAndRepairStreakAndTasks(user) {
        if (!user || !Array.isArray(user.tasks)) return user;
        const hist = Array.isArray(user.pointsHistory) ? user.pointsHistory : [];
        let changed = false;
        let tasks = [...user.tasks];
        let taskStreak = user.taskStreak;
        let longestStreak = user.longestStreak || 0;

        tasks = tasks.map(t => {
            if (!t) return t;
            if (!t.completed && taskLooksCompleted(t, hist)) {
                changed = true;
                return { ...t, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(t) ? false : (t.autoPenaltyApplied || false) };
            }
            return t;
        });

        if ((taskStreak === 0 || taskStreak === undefined) && longestStreak > 0) {
            const hasActiveBreak = Array.isArray(user.streakHistory) && user.streakHistory.length > 0;
            if (!hasActiveBreak) {
                taskStreak = longestStreak;
                changed = true;
            }
        }

        if (!changed) return user;
        return {
            ...user,
            tasks,
            taskStreak: taskStreak !== undefined ? taskStreak : (user.taskStreak || 0),
            longestStreak: Math.max(longestStreak, taskStreak || 0)
        };
    }

    function mergeUserData(local, remote, tabWrittenSync) {
        if (!remote) return local;
        if (!local) return remote;

        const remoteSync = Number(remote.lastSync) || 0;
        const localSync = Number(local.lastSync) || 0;

        const mergedBadges = mergeBadges(local.badges, remote.badges, local, remote);
        const mergedExams = mergeExams(local.exams || [], remote.exams || []);
        const mergedDeletedTaskIds = Array.from(new Set([
            ...(Array.isArray(local.deletedTaskIds) ? local.deletedTaskIds : []),
            ...(Array.isArray(remote.deletedTaskIds) ? remote.deletedTaskIds : [])
        ]));
        const mergedDeletedExamIds = Array.from(new Set([
            ...(Array.isArray(local.deletedExamIds) ? local.deletedExamIds : []),
            ...(Array.isArray(remote.deletedExamIds) ? remote.deletedExamIds : [])
        ]));

        const mergedPointsHistory = mergePointsHistory(local.pointsHistory, remote.pointsHistory);
        const mergedTasks = mergeTasks(local.tasks || [], remote.tasks || [], mergedPointsHistory, mergedDeletedTaskIds);
        const mergedStreakHistory = mergeStreakHistory(local.streakHistory, remote.streakHistory);

        // Streak Count Invariant: Never lose streak progress due to stale device syncing
        let localStreak = Number(local.taskStreak) || 0;
        let remoteStreak = Number(remote.taskStreak) || 0;
        let localLongest = Number(local.longestStreak) || 0;
        let remoteLongest = Number(remote.longestStreak) || 0;

        const isShelyUser = local.username === 'שליי' || local.name === 'שלי' || remote.username === 'שליי' || remote.name === 'שלי';
        if (isShelyUser) {
            if (localStreak === 67) localStreak = 50;
            if (remoteStreak === 67) remoteStreak = 50;
            if (localLongest === 67) localLongest = 50;
            if (remoteLongest === 67) remoteLongest = 50;
        }

        const mergedTaskStreak = Math.max(localStreak, remoteStreak);
        const mergedLongestStreak = Math.max(localLongest, remoteLongest, mergedTaskStreak);

        let mergedStreakStart = local.currentStreakStart || remote.currentStreakStart || null;
        if (local.currentStreakStart && remote.currentStreakStart) {
            const timeLocal = new Date(local.currentStreakStart).getTime();
            const timeRemote = new Date(remote.currentStreakStart).getTime();
            if (!isNaN(timeLocal) && !isNaN(timeRemote)) {
                mergedStreakStart = timeLocal <= timeRemote ? local.currentStreakStart : remote.currentStreakStart;
            }
        }

        const mergedStreakEmojis = Array.from(new Set([
            ...(Array.isArray(local.currentStreakEmojis) ? local.currentStreakEmojis : []),
            ...(Array.isArray(remote.currentStreakEmojis) ? remote.currentStreakEmojis : [])
        ]));

        // Points Invariant: Never decrease points due to stale device syncing
        const mergedTotalPoints = Math.max(Number(local.totalPoints) || 0, Number(remote.totalPoints) || 0);

        // Weekly Reset Invariants: A device that has already reset for a NEW week must never have
        // its reset weekly points overridden by an older device that has not reset yet.
        const localReset = Number(local.nextWeeklyReset) || 0;
        const remoteReset = Number(remote.nextWeeklyReset) || 0;
        let mergedWeeklyPoints;
        let mergedNextWeeklyReset;
        let mergedNextWeeklyCrowning;

        if (localReset > remoteReset) {
            // Local is in a newer week reset cycle
            mergedWeeklyPoints = Number(local.weeklyPoints) || 0;
            mergedNextWeeklyReset = localReset;
            mergedNextWeeklyCrowning = Number(local.nextWeeklyCrowning) || Number(remote.nextWeeklyCrowning) || 0;
        } else if (remoteReset > localReset) {
            // Remote is in a newer week reset cycle
            mergedWeeklyPoints = Number(remote.weeklyPoints) || 0;
            mergedNextWeeklyReset = remoteReset;
            mergedNextWeeklyCrowning = Number(remote.nextWeeklyCrowning) || Number(local.nextWeeklyCrowning) || 0;
        } else {
            // Both devices are on the same week reset target
            const localSyncTime = Number(local.lastSync) || 0;
            const remoteSyncTime = Number(remote.lastSync) || 0;
            if (Number(remote.weeklyPoints) === 0 && remoteSyncTime >= localSyncTime) {
                mergedWeeklyPoints = 0;
            } else if (Number(local.weeklyPoints) === 0 && localSyncTime > remoteSyncTime) {
                mergedWeeklyPoints = 0;
            } else {
                mergedWeeklyPoints = Math.max(Number(local.weeklyPoints) || 0, Number(remote.weeklyPoints) || 0);
            }
            const currentWeekStart = typeof getCurrentWeekStart === 'function' ? getCurrentWeekStart(Date.now()) : 0;
            const nextSunday00AM = typeof getNextWeekReset === 'function' ? getNextWeekReset(Date.now()) : (currentWeekStart + (7 * 86400000));
            mergedNextWeeklyReset = localReset || nextSunday00AM;
            mergedNextWeeklyCrowning = Math.max(Number(local.nextWeeklyCrowning) || 0, Number(remote.nextWeeklyCrowning) || 0);
        }

        // Hermetic Boundary Invariant: If week reset/crowning completed for Sunday 00:00, ensure weeklyPoints is 0 if no points earned this week
        const nowForSync = Date.now();
        const currentWeekStart = typeof getCurrentWeekStart === 'function' ? getCurrentWeekStart(nowForSync) : 0;
        const resetDone = (local.lastCrownedWeekEnd && local.lastCrownedWeekEnd >= currentWeekStart) || 
                          (remote.lastCrownedWeekEnd && remote.lastCrownedWeekEnd >= currentWeekStart) ||
                          (Number(remote.weeklyPoints) === 0 && Number(remote.lastWeekPoints) > 0);
        if (resetDone) {
            const effCalculated = typeof getEffectiveWeeklyPoints === 'function'
                ? getEffectiveWeeklyPoints({ ...local, ...remote, tasks: mergedTasks, pointsHistory: mergedPointsHistory }, nowForSync)
                : null;
            if (effCalculated !== null && (effCalculated === 0 || mergedWeeklyPoints > effCalculated)) {
                mergedWeeklyPoints = effCalculated;
            }
        }

        // WhatsApp Automation Invariants: Never wipe out sent markers from stale tabs/devices
        const localWeek = local.lastWeeklyReportSentWeek || '';
        const remoteWeek = remote.lastWeeklyReportSentWeek || '';
        const mergedWeeklyReportSentWeek = (localWeek.localeCompare(remoteWeek) >= 0 && localWeek !== '')
            ? localWeek
            : (remoteWeek || localWeek || '');
        const mergedWeeklyReportSentTime = Math.max(
            Number(local.lastWeeklyReportSentTime) || 0,
            Number(remote.lastWeeklyReportSentTime) || 0
        );
        const mergedGlobalReminderSent = Math.max(
            Number(local.lastGlobalWhatsAppReminderSent) || 0,
            Number(remote.lastGlobalWhatsAppReminderSent) || 0
        );

        // Weekly Crowning Invariants: Always preserve crowning timestamps across devices
        const mergedLastCrownedWeekEnd = Math.max(Number(local.lastCrownedWeekEnd) || 0, Number(remote.lastCrownedWeekEnd) || 0);
        const mergedCrownedWeekPoints = Math.max(Number(local.crownedWeekPoints) || 0, Number(remote.crownedWeekPoints) || 0);

        // Scalar preferences: take from whichever is newer for user settings
        const preferRemote = remoteSync >= localSync;
        const base = preferRemote ? { ...local, ...remote } : { ...remote, ...local };

        const result = {
            ...base,
            tasks: mergedTasks,
            pointsHistory: mergedPointsHistory,
            streakHistory: mergedStreakHistory,
            taskStreak: mergedTaskStreak,
            longestStreak: mergedLongestStreak,
            currentStreakStart: mergedStreakStart,
            currentStreakEmojis: mergedStreakEmojis,
            totalPoints: mergedTotalPoints,
            weeklyPoints: mergedWeeklyPoints,
            lastCrownedWeekEnd: mergedLastCrownedWeekEnd || base.lastCrownedWeekEnd,
            crownedWeekPoints: mergedCrownedWeekPoints || base.crownedWeekPoints,
            nextWeeklyCrowning: mergedNextWeeklyCrowning || base.nextWeeklyCrowning,
            nextWeeklyReset: mergedNextWeeklyReset || base.nextWeeklyReset,
            lastWeeklyReportSentWeek: mergedWeeklyReportSentWeek,
            lastWeeklyReportSentTime: mergedWeeklyReportSentTime,
            lastGlobalWhatsAppReminderSent: mergedGlobalReminderSent,
            badges: mergedBadges,
            exams: mergedExams,
            deletedTaskIds: mergedDeletedTaskIds,
            deletedExamIds: mergedDeletedExamIds,
            lastSync: Math.max(localSync, remoteSync, Date.now())
        };

        return healCompletedFromHistory(result);
    }

    function applyRemoteUser(local, remote, tabWrittenSync) {
        return mergeUserData(local, remote, tabWrittenSync);
    }

    function healCompletedFromHistory(user) {
        if (!user) return user;
        const hist = [...(user.pointsHistory || [])];
        let changed = false;
        let totalPoints = user.totalPoints || 0;
        let weeklyPoints = user.weeklyPoints || 0;
        let taskStreak = user.taskStreak;
        let streakHistory = [...(user.streakHistory || [])];
        let newHist = [...hist];
        const weekStart = getLastSaturday22PM();

        const deletedSet = new Set(Array.isArray(user.deletedTaskIds) ? user.deletedTaskIds : []);
        const subMap = new Map((user.subjects || []).map(s => [s.id, s.name || '']));
        const rawTasks = Array.isArray(user.tasks) ? user.tasks : [];
        const inputTasks = rawTasks.filter(t => {
            if (!t || !t.id) return false;
            if (deletedSet.has(t.id)) {
                changed = true;
                return false;
            }
            const subName = subMap.get(t.subjectId) || '';
            const isPhysics = subName.includes('פיזיקה');
            const isCivics = subName.includes('אזרחות');
            const titleOrTopic = `${t.title || ''} ${t.lessonTopic || ''}`;
            const mentionsCivics = titleOrTopic.includes('אזרחות') || titleOrTopic.includes('אופיה של מדינת ישראל') || titleOrTopic.includes('מגילת העצמאות');
            const mentionsPhysics = titleOrTopic.includes('פיזיקה') || titleOrTopic.includes('קולון') || titleOrTopic.includes('דופלר') || titleOrTopic.includes('אנרגיה חשמלית');

            if (isPhysics && mentionsCivics && !mentionsPhysics) {
                deletedSet.add(t.id);
                changed = true;
                return false;
            }
            if (isCivics && mentionsPhysics && !mentionsCivics) {
                deletedSet.add(t.id);
                changed = true;
                return false;
            }
            return true;
        });

        const tasks = inputTasks.map((t) => {
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
                const wasActuallyOnTime = onTime || updated.isPracticeSession || updated.isFlexibleExamSession || !updated.dueDate || (dueDate && !isNaN(dueDate.getTime()) && subDate.getTime() <= (dueDate.getTime() + (5 * 60 * 1000)));

                if (wasActuallyOnTime) {
                    if (updated.autoPenaltyApplied) {
                        updated.autoPenaltyApplied = false;
                        changed = true;
                    }
                    if (updated.lateReason) {
                        delete updated.lateReason;
                        changed = true;
                    }

                    // Points calculation
                    let expectedPoints = updated.pointsEarned;
                    if (expectedPoints === undefined || expectedPoints <= 0) {
                        if (updated.isPracticeSession) {
                            expectedPoints = (updated.studyDurationMinutes >= 30 || updated.studyDurationHours >= 0.5) ? 2 : 1;
                        } else if (updated.rewardPoints || updated.isFlexibleExamSession) {
                            expectedPoints = updated.rewardPoints || 3;
                        } else {
                            const createdAt = updated.createdAt ? new Date(updated.createdAt) : null;
                            expectedPoints = 1;
                            if (dueDate && createdAt && !isNaN(dueDate.getTime()) && !isNaN(createdAt.getTime())) {
                                const totalMs = dueDate.getTime() - createdAt.getTime();
                                const usedMs = subDate.getTime() - createdAt.getTime();
                                if (usedMs <= Math.max(totalMs / 2, 86400000)) expectedPoints = 2;
                            }
                            if (updated.isExamPrep) expectedPoints += 1;
                        }
                    }

                    // Ensure pointsHistory has an entry for this completed task
                    const hasPositiveHist = newHist.some(h => h && h.taskId === updated.id && (h.points || 0) > 0 && !isAutoHistoryId(h.id));
                    if (!hasPositiveHist && !updated.givenUp) {
                        const sub = (user.subjects || []).find(s => s.id === updated.subjectId);
                        const pointsVal = Math.max(1, expectedPoints || (updated.isPracticeSession ? 2 : 1));
                        updated.pointsEarned = pointsVal;
                        const subName = sub ? sub.name : 'כללי';
                        const subEmoji = sub ? sub.emoji : '📚';
                        const detailsStr = updated.isPracticeSession
                            ? `בוצע סשן תרגול מעמיק (+${pointsVal} נקודות)! 💡`
                            : (pointsVal >= 2 ? 'הוגש מוקדם! אלופה.' : 'הוגש בזמן שנקבע.');

                        const healedLog = {
                            id: 'ph_healed_' + updated.id,
                            taskId: updated.id,
                            taskTitle: updated.title,
                            subjectName: subName,
                            subjectEmoji: subEmoji,
                            points: pointsVal,
                            date: updated.completedAt || new Date().toISOString(),
                            details: detailsStr,
                            studyDurationHours: updated.studyDurationHours || null,
                            studyDurationMinutes: updated.studyDurationMinutes || null,
                            studyTimeRange: updated.studyTimeRange || null
                        };

                        newHist.unshift(healedLog);
                        totalPoints += pointsVal;
                        if (subDate.getTime() >= weekStart) {
                            weeklyPoints += pointsVal;
                        }
                        changed = true;
                    } else if ((updated.pointsEarned === undefined || updated.pointsEarned <= 0) && !updated.givenUp) {
                        const delta = expectedPoints - (updated.pointsEarned || 0);
                        if (delta > 0) {
                            totalPoints += delta;
                            if (subDate.getTime() >= weekStart) {
                                weeklyPoints += delta;
                            }
                            updated.pointsEarned = expectedPoints;
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

        // Strict boundary: clamp weekly points to points earned in the current week (since Sunday 00:00)
        const nowForHeal = Date.now();
        const curWeekStart = typeof getCurrentWeekStart === 'function' ? getCurrentWeekStart(nowForHeal) : 0;
        const crowningOrResetDone = (user.lastCrownedWeekEnd && user.lastCrownedWeekEnd >= curWeekStart) || (Number(user.lastWeekPoints) > 0 && user.nextWeeklyReset && nowForHeal < user.nextWeeklyReset);
        const effHealed = typeof getEffectiveWeeklyPoints === 'function'
            ? getEffectiveWeeklyPoints({ ...user, tasks, pointsHistory: newHist }, nowForHeal)
            : null;
        if (effHealed !== null && (effHealed === 0 || weeklyPoints > effHealed)) {
            if (crowningOrResetDone) {
                weeklyPoints = effHealed;
                changed = true;
            }
        }

        const isShely = (user.username && (user.username === 'שליי' || user.username === 'שלי')) || 
                (user.name && (user.name === 'שלי' || user.name === 'שליי')) || 
                (user.id && (user.id === 'שליי' || user.id === 'שלי' || user.id === '0bH9B6rJ1sduoF2i6k7aD2k4sB33'));
        const isInbar = (user.username && user.username.includes('ענבר')) || (user.name && user.name.includes('ענבר'));

        // Streak healing: preserve real active streak without artificial lifetime task inflation
        let streakVal = taskStreak !== undefined ? taskStreak : (user.taskStreak || 0);
        let longestVal = user.longestStreak || 0;
        if (isShely) {
            if (streakVal === 67) streakVal = 50;
            if (longestVal === 67) longestVal = 50;
        }
        const safeStreak = Math.max(streakVal, 0);
        const safeLongest = Math.max(longestVal, safeStreak);

        // Canonical Crown Architecture: Distinct wonWeeks Set
        // Shely has 5 official wins up to Week 44. Inbar has 4 official wins.
        // Count is derived deterministically from wonWeeks so it can NEVER inflate arbitrarily.
        let badges = user.badges ? [...user.badges] : [];
        if (badges.length > 0) {
            const champBadgeIdx = badges.findIndex(b => (typeof b === 'object' && b && b.id === 'b_weekly_champ'));
            if (champBadgeIdx !== -1) {
                const bObj = { ...badges[champBadgeIdx] };
                let wonWeeks = Array.isArray(bObj.wonWeeks) ? Array.from(new Set(bObj.wonWeeks)) : [];
                
                const lastWonTime = bObj.lastWonAt ? new Date(bObj.lastWonAt).getTime() : 0;
                const hasFutureTimestamp = lastWonTime >= 1794081600000; // on or after Nov 7, 2026 22:00

                if (isShely) {
                    const baseWeeksShely = ['2026-W37', '2026-W38', '2026-W40', '2026-W42', '2026-W44'];
                    let futureWeeks = wonWeeks.filter(w => w > '2026-W44' && w !== '2026-W45');
                    const finalWeeks = Array.from(new Set([...baseWeeksShely, ...futureWeeks]));
                    bObj.wonWeeks = finalWeeks;
                    bObj.count = finalWeeks.length;
                    bObj.lastWonWeek = finalWeeks[finalWeeks.length - 1] || '2026-W44';
                    badges[champBadgeIdx] = bObj;
                    changed = true;
                } else if (isInbar) {
                    const baseWeeksInbar = ['2026-W36', '2026-W39', '2026-W41', '2026-W43', '2026-W45'];
                    let futureWeeks = wonWeeks.filter(w => w > '2026-W45');
                    const finalWeeks = Array.from(new Set([...baseWeeksInbar, ...futureWeeks]));
                    bObj.wonWeeks = finalWeeks;
                    bObj.count = finalWeeks.length;
                    bObj.lastWonWeek = finalWeeks[finalWeeks.length - 1] || '2026-W45';
                    badges[champBadgeIdx] = bObj;
                    changed = true;
                }
            }
        }

        if (!changed && safeStreak === (user.taskStreak || 0) && safeLongest === (user.longestStreak || 0)) {
            return user;
        }

        return {
            ...user,
            tasks,
            totalPoints,
            weeklyPoints,
            pointsHistory: newHist,
            badges: badges.length > 0 ? badges : user.badges,
            taskStreak: safeStreak,
            longestStreak: safeLongest,
            streakHistory,
            deletedTaskIds: Array.from(deletedSet)
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
        mergeExams,
        applyRemoteUser,
        mergeUserData,
        mergePointsHistory,
        mergeStreakHistory,
        verifyAndRepairStreakAndTasks,
        healCompletedFromHistory,
        restoreOnDueEdit,
        taskLooksCompleted,
        isTaskSubmittedOnTime,
        isAutoHistoryId,
        getCurrentWeekStart,
        getNextWeekReset,
        getLastSaturday22PM,
        getEffectiveWeeklyPoints,
        normalizeBadge,
        mergeBadges,
        markPendingSync,
        getPendingSync,
        clearPendingSync,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.mergeTasks = mergeTasks;
    root.mergeExams = mergeExams;
    root.applyRemoteUser = applyRemoteUser;
    root.mergeUserData = mergeUserData;
    root.mergePointsHistory = mergePointsHistory;
    root.mergeStreakHistory = mergeStreakHistory;
    root.verifyAndRepairStreakAndTasks = verifyAndRepairStreakAndTasks;
    root.healCompletedFromHistory = healCompletedFromHistory;
    root.restoreOnDueEdit = restoreOnDueEdit;
    root.taskLooksCompleted = taskLooksCompleted;
    root.isTaskSubmittedOnTime = isTaskSubmittedOnTime;
    root.getCurrentWeekStart = getCurrentWeekStart;
    root.getNextWeekReset = getNextWeekReset;
    root.getLastSaturday22PM = getLastSaturday22PM;
    root.getEffectiveWeeklyPoints = getEffectiveWeeklyPoints;
    root.normalizeBadge = normalizeBadge;
    root.mergeBadges = mergeBadges;
    root.markPendingSync = markPendingSync;
    root.getPendingSync = getPendingSync;
    root.clearPendingSync = clearPendingSync;
})(typeof globalThis !== "undefined" ? globalThis : this);
