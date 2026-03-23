import { useEffect, useMemo, useRef, useState } from "react";

type AthleteStatus = "autonomo" | "guiado";

type Athlete = {
  id: string;
  name: string;
  status: AthleteStatus;
  startExercise: string;
  isNew: boolean;
};

type SessionState = {
  sessionTime: string;
  coachName: string;
  movementsText: string;
  athletes: Athlete[];
};

type AttentionItem = {
  athleteId: string;
  athleteName: string;
  startExercise: string;
  step: string;
};

type SavedSession = {
  id: string;
  createdAt: string;
  sessionTime: string;
  coachName: string;
  movements: string[];
  athletes: Athlete[];
  attentionOrder: AttentionItem[];
};

type ViewMode = "board" | "history";
type MovementPresetId = "M1" | "M2" | "M3" | "M4" | "M5";

const STORAGE_KEY = "ups-session-v11";
const HISTORY_STORAGE_KEY = "ups-session-history-v1";
const MOVEMENT_PRESETS: Record<MovementPresetId, string[]> = {
  M1: [
    "//Hip Thrust B-Stance & Step Up c/ Mancuerna (Glúteos)",
    "Sentadilla Globet Pulso c/ Talón Elevado",
    "Press Plano c/ Mancuernas",
    "Rack Chin",
    "Extra",
  ],
  M2: [
    "Peso Muerto Rumano c/ Mancuernas",
    "Sentadillas Bulgaras",
    "Elevaciones laterales 1 Brazo",
    "Remo Abierto c/ Mancuernas",
    "Extra",
  ],
  M3: [
    "Puente de Glúteos 1 Pierna o Peso Muerto Rumano 1 Pierna",
    "Sentadillas Splits (Glúteos)",
    "Press Militar Sentado c/ Mancuerna",
    "Rack Chin Supino",
    "Extra",
  ],
  M4: [
    "Curl de Isquios c/ Mancuernas",
    "Sentadilla Globet Pulso c/ Talón Elevado",
    "Press Militar c/ Mancuernas",
    "Rompecraneos y Floor Press Cerrado c/ Mancuernas",
    "Extra",
  ],
  M5: [
    "Peso Muerto Rumano c/ Mancuernas",
    "Sentadilla Split Talón Elevado Asistido",
    "Rompecraneos y Floor Press Cerrado c/ Mancuernas",
    "Remo Abierto c/ Mancuernas",
    "Extra",
  ],
};

const TURN_TIMES = Array.from({ length: 16 }, (_, index) => {
  const hour = 7 + index;
  return `${String(hour).padStart(2, "0")}:00`;
});

function createEmptyState(): SessionState {
  return {
    sessionTime: "",
    coachName: "",
    movementsText: "",
    athletes: [],
  };
}

function createAthlete(name = ""): Athlete {
  return {
    id: crypto.randomUUID(),
    name,
    status: "guiado",
    startExercise: "",
    isNew: false,
  };
}

function statusLabel(status: AthleteStatus) {
  return status === "autonomo" ? "Inicio Autónomo" : "Inicio Guiado";
}

function attentionStepClass(step: string) {
  if (step === "Dar expectativas") return "order-tag-expectations";
  if (step === "Targets & Aprox.") return "order-tag-targets";
  if (step === "Volver a guiado") return "order-tag-return";
  return "";
}

function formatSavedAt(value: string) {
  return new Date(value).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sanitizeHistoryData(input: unknown): SavedSession[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry: Partial<SavedSession>): SavedSession => ({
      id: entry.id || crypto.randomUUID(),
      createdAt: entry.createdAt || new Date().toISOString(),
      sessionTime: entry.sessionTime || "",
      coachName: entry.coachName || "",
      movements: Array.isArray(entry.movements)
        ? entry.movements.filter((item): item is string => typeof item === "string")
        : [],
      athletes: Array.isArray(entry.athletes)
        ? entry.athletes.map(
            (athlete: Partial<Athlete>): Athlete => ({
              id: athlete.id || crypto.randomUUID(),
              name: athlete.name || "",
              status: athlete.status === "autonomo" ? "autonomo" : "guiado",
              startExercise: athlete.startExercise || "",
              isNew: athlete.status === "autonomo" ? false : Boolean(athlete.isNew),
            })
          )
        : [],
      attentionOrder: Array.isArray(entry.attentionOrder)
        ? entry.attentionOrder
            .filter(Boolean)
            .map((item: Partial<AttentionItem>): AttentionItem => ({
              athleteId: item.athleteId || crypto.randomUUID(),
              athleteName: item.athleteName || "",
              startExercise: item.startExercise || "",
              step: item.step || "",
            }))
        : [],
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sanitizeLoadedState(raw: string | null): SessionState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);

    const safeAthletes: Athlete[] = Array.isArray(parsed?.athletes)
      ? parsed.athletes.map((athlete: Partial<Athlete>) => ({
          id: athlete.id || crypto.randomUUID(),
          name: athlete.name || "",
          status: athlete.status === "autonomo" ? "autonomo" : "guiado",
          startExercise: athlete.startExercise || "",
          isNew: athlete.status === "autonomo" ? false : Boolean(athlete.isNew),
        }))
      : [];

    return {
      sessionTime: parsed?.sessionTime || "",
      coachName: parsed?.coachName || "",
      movementsText: parsed?.movementsText || "",
      athletes: safeAthletes,
    };
  } catch {
    return null;
  }
}

function sanitizeHistory(raw: string | null): SavedSession[] {
  if (!raw) return [];

  try {
    return sanitizeHistoryData(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function fetchSharedSessions(): Promise<SavedSession[] | null> {
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) return null;
    return sanitizeHistoryData(await response.json());
  } catch {
    return null;
  }
}

async function createSharedSession(session: SavedSession): Promise<boolean> {
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(session),
    });

    return response.ok;
  } catch {
    return false;
  }
}

function buildAttentionOrder(athletes: Athlete[]): AttentionItem[] {
  const activeAthletes = athletes.filter((athlete) => athlete.name.trim() !== "");
  const guided = activeAthletes.filter((athlete) => athlete.status === "guiado");
  const autonomous = activeAthletes.filter((athlete) => athlete.status === "autonomo");

  return [
    ...guided.map((athlete) => ({
      athleteId: athlete.id,
      athleteName: athlete.name,
      startExercise: athlete.startExercise,
      step: "Dar expectativas",
    })),
    ...autonomous.map((athlete) => ({
      athleteId: athlete.id,
      athleteName: athlete.name,
      startExercise: athlete.startExercise,
      step: "Targets & Aprox.",
    })),
    ...guided.map((athlete) => ({
      athleteId: athlete.id,
      athleteName: athlete.name,
      startExercise: athlete.startExercise,
      step: "Volver a guiado",
    })),
  ];
}

function buildExerciseGroups(athletes: Athlete[], movements: string[]) {
  const movementOrder = new Map(movements.map((movement, index) => [movement.trim(), index]));
  const map = new Map<string, Athlete[]>();

  for (const athlete of athletes) {
    if (athlete.name.trim() === "") continue;

    const key = athlete.startExercise.trim() || "Sin asignar";

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key)!.push(athlete);
  }

  return Array.from(map.entries()).sort((a, b) => {
    if (a[0] === "Sin asignar") return 1;
    if (b[0] === "Sin asignar") return -1;

    const aIndex = movementOrder.get(a[0]);
    const bIndex = movementOrder.get(b[0]);

    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex;
    }

    if (aIndex !== undefined) return -1;
    if (bIndex !== undefined) return 1;

    return a[0].localeCompare(b[0]);
  });
}

export default function App() {
  const [state, setState] = useState<SessionState>(createEmptyState);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [selectedPreset, setSelectedPreset] = useState<MovementPresetId | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [collapsedAthletes, setCollapsedAthletes] = useState<Record<string, boolean>>({});
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [storageMode, setStorageMode] = useState<"shared" | "local">("local");
  const [isSavingSession, setIsSavingSession] = useState(false);
  const historyDetailRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const loaded = sanitizeLoadedState(localStorage.getItem(STORAGE_KEY));
    const history = sanitizeHistory(localStorage.getItem(HISTORY_STORAGE_KEY));

    if (loaded) {
      setState(loaded);
    }

    setSavedSessions(history);
    setSelectedSessionId(history[0]?.id || null);

    setHydrated(true);

    void (async () => {
      const sharedHistory = await fetchSharedSessions();
      if (!sharedHistory) return;

      setSavedSessions(sharedHistory);
      setSelectedSessionId((prev) =>
        prev && sharedHistory.some((session) => session.id === prev)
          ? prev
          : (sharedHistory[0]?.id ?? null)
      );
      setStorageMode("shared");
    })();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(savedSessions));
  }, [savedSessions, hydrated]);

  useEffect(() => {
    if (!saveMessage) return;
    const timeout = window.setTimeout(() => setSaveMessage(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [saveMessage]);

  useEffect(() => {
    if (viewMode !== "history" || !selectedSessionId) return;
    if (!window.matchMedia("(max-width: 1100px)").matches) return;

    historyDetailRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [selectedSessionId, viewMode]);

  const movementList = useMemo(() => {
    return state.movementsText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }, [state.movementsText]);

  const namedAthletes = useMemo(() => {
    return state.athletes.filter((athlete) => athlete.name.trim() !== "");
  }, [state.athletes]);

  const namedAthletesCount = namedAthletes.length;

  const attentionOrder = useMemo(() => {
    return buildAttentionOrder(state.athletes);
  }, [state.athletes]);

  const groupedByExercise = useMemo(() => {
    return buildExerciseGroups(namedAthletes, movementList);
  }, [namedAthletes, movementList]);

  const selectedSession = useMemo(() => {
    return savedSessions.find((session) => session.id === selectedSessionId) || null;
  }, [savedSessions, selectedSessionId]);

  const selectedSessionExerciseGroups = useMemo(() => {
    if (!selectedSession) return [];
    return buildExerciseGroups(selectedSession.athletes, selectedSession.movements);
  }, [selectedSession]);

  function updateAthlete(id: string, patch: Partial<Athlete>) {
    setState((prev) => ({
      ...prev,
      athletes: prev.athletes.map((athlete) =>
        athlete.id === id ? { ...athlete, ...patch } : athlete
      ),
    }));
  }

  function addAthlete() {
    setState((prev) => ({
      ...prev,
      athletes: [...prev.athletes, createAthlete()],
    }));
  }

  function removeAthlete(id: string) {
    setState((prev) => ({
      ...prev,
      athletes: prev.athletes.filter((athlete) => athlete.id !== id),
    }));

    setCollapsedAthletes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function toggleAthleteCollapsed(id: string) {
    setCollapsedAthletes((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }

  function goToAthletesStep() {
    setState((prev) => {
      if (prev.athletes.length > 0) return prev;

      return {
        ...prev,
        athletes: [createAthlete()],
      };
    });

    setStep(2);
  }

  function applyMovementPreset(presetId: MovementPresetId) {
    setSelectedPreset(presetId);
    setState((prev) => ({
      ...prev,
      movementsText: MOVEMENT_PRESETS[presetId].join("\n"),
    }));
  }

  function updateMovementsText(value: string) {
    setState((prev) => ({ ...prev, movementsText: value }));

    const matchingPreset =
      (Object.entries(MOVEMENT_PRESETS).find(
        ([, movements]) => movements.join("\n") === value
      )?.[0] as MovementPresetId | undefined) ?? null;

    setSelectedPreset(matchingPreset);
  }

  function resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    setState(createEmptyState());
    setSelectedPreset(null);
    setCollapsedAthletes({});
    setStep(1);
  }

  function buildSessionSnapshot(): SavedSession {
    return {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      sessionTime: state.sessionTime,
      coachName: state.coachName,
      movements: movementList,
      athletes: namedAthletes.map((athlete) => ({ ...athlete })),
      attentionOrder,
    };
  }

  async function saveAndStartNewSession() {
    const snapshot = buildSessionSnapshot();
    setIsSavingSession(true);

    const sharedSaved = await createSharedSession(snapshot);

    if (sharedSaved) {
      const sharedHistory = await fetchSharedSessions();

      if (sharedHistory) {
        setSavedSessions(sharedHistory);
        setSelectedSessionId(sharedHistory[0]?.id ?? snapshot.id);
      } else {
        setSavedSessions((prev) => [snapshot, ...prev]);
        setSelectedSessionId(snapshot.id);
      }

      setStorageMode("shared");
      setSaveMessage("Sesión guardada y compartida.");
    } else {
      setSavedSessions((prev) => [snapshot, ...prev]);
      setSelectedSessionId(snapshot.id);
      setStorageMode("local");
      setSaveMessage("Sesión guardada solo localmente.");
    }

    setViewMode("board");
    localStorage.removeItem(STORAGE_KEY);
    setState(createEmptyState());
    setSelectedPreset(null);
    setCollapsedAthletes({});
    setStep(1);
    setIsSavingSession(false);
  }

  const canGoToAthletes = movementList.length > 0;
  const canGoToOrganization = namedAthletesCount > 0;
  const canSaveSession = namedAthletesCount > 0 && attentionOrder.length > 0;

  return (
    <div className="app-shell">
      <div className="page">
        <div className="topbar">
          <div className="topbar-brand">
            <div className="topbar-brand-row">
              <div className="eyebrow">UP.S Session</div>

              <div className="topbar-actions">
                {!(viewMode === "board" && step === 3) ? (
                  <>
                    <button
                      type="button"
                      className={`secondary-btn small-btn ${
                        viewMode === "board" ? "active-view-btn" : ""
                      }`}
                      onClick={() => setViewMode("board")}
                    >
                      Sesión
                    </button>
                    <button
                      type="button"
                      className={`secondary-btn small-btn ${
                        viewMode === "history" ? "active-view-btn" : ""
                      }`}
                      onClick={() => setViewMode("history")}
                    >
                      Historial
                    </button>
                  </>
                ) : null}
                {viewMode === "board" && step !== 1 ? (
                  <button
                    type="button"
                    className={`${
                      step === 3 && canSaveSession ? "primary-btn" : "secondary-btn"
                    } small-btn`}
                    onClick={step === 3 && canSaveSession ? saveAndStartNewSession : resetAll}
                    disabled={isSavingSession}
                  >
                    {step === 3 && canSaveSession
                      ? isSavingSession
                        ? "Guardando..."
                        : "Guardar y nueva sesión"
                      : "Nueva sesión"}
                  </button>
                ) : null}
              </div>
            </div>

            <h1>Pre-sesión</h1>
          </div>
        </div>

        {viewMode === "board" && step !== 1 && step !== 3 ? (
          <div className="mini-stats" style={{ marginBottom: 20 }}>
            <span>{namedAthletesCount} atletas</span>
            <span>{movementList.length} movimientos</span>
            <span>{state.sessionTime || "Sin horario"}</span>
          </div>
        ) : null}

        {viewMode === "history" ? (
          <div className="history-layout">
            <section className="card history-list-card">
              <div className="section-header">
                <div>
                  <h2>Historial</h2>
                  <div className="small-label">
                    {savedSessions.length} sesión{savedSessions.length === 1 ? "" : "es"} guardada
                    {savedSessions.length === 1 ? "" : "s"}
                  </div>
                  <div className="small-label">
                    {storageMode === "shared" ? "Persistencia compartida" : "Persistencia local"}
                  </div>
                </div>
              </div>

              <div className="history-list">
                {savedSessions.length > 0 ? (
                  <>
                    <div className="history-table-head">
                      <span>Horario</span>
                      <span>Coach</span>
                      <span>Datos</span>
                    </div>

                    {savedSessions.map((session) => (
                      <button
                        type="button"
                        key={session.id}
                        className={`history-item ${
                          selectedSessionId === session.id ? "history-item-active" : ""
                        }`}
                        onClick={() => setSelectedSessionId(session.id)}
                      >
                        <div className="history-cell history-cell-time">
                          <strong>{session.sessionTime || "Sin hora"}</strong>
                          <span className="small-label">{formatSavedAt(session.createdAt)}</span>
                        </div>

                        <div className="history-cell history-cell-coach">
                          <strong>{session.coachName || "Sin coach"}</strong>
                        </div>

                        <div className="history-cell history-cell-stats">
                          <span>{session.athletes.length} A</span>
                          <span>{session.movements.length} M</span>
                          <span>{session.attentionOrder.length} P</span>
                        </div>
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="order-item">
                    <div className="order-main">Todavía no hay sesiones guardadas</div>
                  </div>
                )}
              </div>
            </section>

            <section className="card" ref={historyDetailRef}>
              {selectedSession ? (
                <>
                  <div className="section-header">
                    <div>
                      <h2>Detalle</h2>
                      <div className="small-label">
                        {selectedSession.sessionTime || "Sin hora"} ·{" "}
                        {selectedSession.coachName || "Sin coach"}
                      </div>
                    </div>
                  </div>

                  <div className="history-detail-section">
                    <div className="small-label">Atletas</div>
                    <div className="tag-wrap compact-tag-wrap">
                      {selectedSession.athletes.map((athlete) => (
                        <div className="person-tag compact-person-tag" key={athlete.id}>
                          <strong>{athlete.name || "Sin nombre"}</strong>
                          <span>{statusLabel(athlete.status)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="history-detail-section">
                    <div className="small-label">Mapa visual</div>
                    <div className="stack">
                      {selectedSessionExerciseGroups.length > 0 ? (
                        selectedSessionExerciseGroups.map(([exercise, athletes]) => (
                          <div className="exercise-group" key={`history-${exercise}`}>
                            <div className="exercise-group-head">
                              <strong>{exercise}</strong>
                              <span className="group-count">
                                {athletes.length} atleta{athletes.length === 1 ? "" : "s"}
                              </span>
                            </div>

                            <div className="tag-wrap">
                              {athletes.map((athlete) => (
                                <div className="person-tag" key={`history-map-${athlete.id}`}>
                                  <strong>{athlete.name || "Sin nombre"}</strong>
                                  <span>{statusLabel(athlete.status)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="order-item">
                          <div className="order-main">Todavía no hay mapa visual</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="history-detail-section">
                    <div className="small-label">Orden de atención</div>
                    <div className="stack">
                      {selectedSession.attentionOrder.map((item, index) => (
                        <div
                          className="order-item order-timeline-item"
                          key={`${item.athleteId}-${item.step}-${index}-history`}
                        >
                          <div className="order-step-badge">{index + 1}</div>
                          <div className="order-content">
                            <div className="order-main">{item.athleteName || "Sin nombre"}</div>
                          </div>
                          <div className={`order-tag ${attentionStepClass(item.step)}`}>
                            {item.step}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="order-item">
                  <div className="order-main">Seleccioná una sesión guardada</div>
                </div>
              )}
            </section>
          </div>
        ) : step === 1 ? (
          <section className="card centered-card">
            <h2>Sesión</h2>

            <div className="field-grid">
              <div>
                <label>Hora</label>
                <select
                  value={state.sessionTime}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, sessionTime: e.target.value }))
                  }
                >
                  <option value="">Seleccionar turno</option>
                  {TURN_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Coach</label>
                <input
                  value={state.coachName}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, coachName: e.target.value }))
                  }
                  placeholder="Coach"
                />
              </div>
            </div>

            <div>
              <label>Movimientos del día</label>
              <div className="preset-picker">
                {Object.entries(MOVEMENT_PRESETS).map(([presetId]) => (
                  <button
                    type="button"
                    key={presetId}
                    className={`preset-chip ${
                      selectedPreset === presetId ? "preset-chip-active" : ""
                    }`}
                    onClick={() => applyMovementPreset(presetId as MovementPresetId)}
                  >
                    <span>{presetId}</span>
                  </button>
                ))}
              </div>
              <textarea
                rows={6}
                value={state.movementsText}
                onChange={(e) => updateMovementsText(e.target.value)}
                placeholder={
                  "Elevaciones laterales\nPeso Muerto Rumano\nFlexiones de brazos\nSentadillas búlgaras\nExtra"
                }
              />
              <div className="small-label preset-help">
                Tocá un bloque `M1`-`M5` para cargar sus ejercicios y después podés ajustar
                el texto manualmente.
              </div>
            </div>

            <div className="mini-stats">
              <span>{movementList.length} movimientos</span>
            </div>

            <div className="actions-row">
              <button
                type="button"
                className="primary-btn"
                onClick={goToAthletesStep}
                disabled={!canGoToAthletes}
                style={{ opacity: canGoToAthletes ? 1 : 0.5 }}
              >
                Continuar a atletas
              </button>
            </div>
          </section>
        ) : step === 2 ? (
          <>
            <div className="centered-card step-top-actions">
              <button
                type="button"
                className="secondary-btn small-btn"
                onClick={() => setStep(1)}
              >
                Editar ejercicios
              </button>
            </div>

            <section className="card centered-card">
              <div className="section-header">
                <div>
                  <h2>Nombres de atletas</h2>
                  <div className="small-label">
                    Cargá primero todos los atletas de la sesión.
                  </div>
                </div>
              </div>

              <div className="manual-athletes-block">
                <div className="manual-athlete-list">
                  {state.athletes.map((athlete, index) => (
                    <div className="manual-athlete-row" key={athlete.id}>
                      <label className="manual-athlete-label">Atleta {index + 1}</label>

                      <div className="manual-athlete-input-wrap">
                        <input
                          value={athlete.name}
                          onChange={(e) =>
                            updateAthlete(athlete.id, { name: e.target.value })
                          }
                          placeholder="Nombre del atleta"
                        />

                        {state.athletes.length > 1 ? (
                          <button
                            type="button"
                            className="athlete-delete-btn"
                            onClick={() => removeAthlete(athlete.id)}
                            aria-label={`Eliminar atleta ${index + 1}`}
                            title="Eliminar atleta"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="add-athlete-row">
                  <button
                    type="button"
                    className="add-athlete-btn"
                    onClick={addAthlete}
                  >
                    <span className="add-athlete-plus">+</span>
                    <span>Agregar atleta</span>
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginTop: 20,
                }}
              >
              <div className="small-label">{namedAthletesCount} nombres listos</div>

                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => setStep(3)}
                  disabled={!canGoToOrganization}
                  style={{ opacity: canGoToOrganization ? 1 : 0.5 }}
                >
                  Continuar a organización
                </button>
              </div>
            </section>
          </>
        ) : (
          <div className="grid">
            <section className="card compact-session-card">
              <div className="session-card-head">
                <div>
                  <h2 className="compact-title">Sesión</h2>
                  <div className="small-label session-card-subtitle">
                    {state.sessionTime || "Sin hora"} · {state.coachName || "Sin coach"}
                  </div>
                </div>
              </div>

              {saveMessage ? <div className="save-banner">{saveMessage}</div> : null}

              <div className="movement-pills">
                {movementList.length > 0 ? (
                  movementList.map((movement, index) => (
                    <span key={`${movement}-${index}`} className="pill">
                      {movement}
                    </span>
                  ))
                ) : (
                  <span className="pill">Sin movimientos</span>
                )}
              </div>

              <div className="session-card-actions">
                <button
                  type="button"
                  className="secondary-btn small-btn"
                  onClick={() => setStep(1)}
                >
                  Editar ejercicios
                </button>

                <button
                  type="button"
                  className="secondary-btn small-btn"
                  onClick={goToAthletesStep}
                >
                  Editar atletas
                </button>
              </div>
            </section>

            <section className="card">
              <div className="section-header">
                <div>
                  <h2>Organización</h2>
                </div>
              </div>

              <div className="mobile-map-preview">
                <div className="mobile-map-preview-head">
                  <span className="small-label">Mapa</span>
                  <span className="small-label">
                    {groupedByExercise.length} grupo{groupedByExercise.length === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="mobile-map-preview-pills">
                  {groupedByExercise.length > 0 ? (
                    groupedByExercise.map(([exercise, athletes]) => (
                      <span className="summary-pill" key={`mobile-map-${exercise}`}>
                        {exercise} · {athletes.length}
                      </span>
                    ))
                  ) : (
                    <span className="summary-pill">Sin mapa visual</span>
                  )}
                </div>
              </div>

              <div className="athlete-list" style={{ marginTop: 18 }}>
                {namedAthletes.length > 0 ? (
                  namedAthletes.map((athlete, index) => {
                    const isCollapsed = Boolean(collapsedAthletes[athlete.id]);

                    return (
                      <div
                        className={`athlete-card ${isCollapsed ? "athlete-card-collapsed" : ""}`}
                        key={athlete.id}
                      >
                        <div className="section-header athlete-card-head">
                          <div className="athlete-card-meta">
                            {isCollapsed ? (
                              <>
                                <div className="athlete-title" style={{ marginBottom: 0 }}>
                                  {athlete.name || `Atleta ${index + 1}`}
                                </div>

                                <div className="collapsed-header-pills">
                                  <span className="summary-pill">
                                    {statusLabel(athlete.status)}
                                  </span>
                                  <span className="summary-pill">
                                    {athlete.startExercise || "Sin ejercicio de inicio"}
                                  </span>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="small-label">Atleta {index + 1}</div>
                                <div className="athlete-title" style={{ marginBottom: 0 }}>
                                  {athlete.name || `Atleta ${index + 1}`}
                                </div>
                              </>
                            )}
                          </div>

                          <div className="tiny-actions">
                            {!isCollapsed ? (
                              <div className="badge">{statusLabel(athlete.status)}</div>
                            ) : null}

                            <button
                              type="button"
                              className="mini-btn icon-mini-btn"
                              onClick={() => toggleAthleteCollapsed(athlete.id)}
                              aria-label={isCollapsed ? "Expandir atleta" : "Minimizar atleta"}
                              title={isCollapsed ? "Expandir" : "Minimizar"}
                            >
                              {isCollapsed ? "▾" : "▴"}
                            </button>
                          </div>
                        </div>

                        {!isCollapsed ? (
                          <div className="field-grid athlete-form-grid" style={{ marginTop: 12 }}>
                            <div>
                              <label>Ejercicio de inicio</label>
                              <select
                                value={athlete.startExercise}
                                onChange={(e) =>
                                  updateAthlete(athlete.id, {
                                    startExercise: e.target.value,
                                  })
                                }
                              >
                                <option value="">Seleccionar ejercicio</option>
                                {movementList.map((movement) => (
                                  <option key={movement} value={movement}>
                                    {movement}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label>Estado</label>
                              <div className="status-toggle" role="tablist" aria-label="Estado">
                                <button
                                  type="button"
                                  className={`status-toggle-btn ${
                                    athlete.status === "guiado" ? "is-active" : ""
                                  }`}
                                  onClick={() =>
                                    updateAthlete(athlete.id, {
                                      status: "guiado",
                                      isNew: false,
                                    })
                                  }
                                >
                                  Guiado
                                </button>

                                <button
                                  type="button"
                                  className={`status-toggle-btn ${
                                    athlete.status === "autonomo" ? "is-active" : ""
                                  }`}
                                  onClick={() =>
                                    updateAthlete(athlete.id, {
                                      status: "autonomo",
                                      isNew: false,
                                    })
                                  }
                                >
                                  Autónomo
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="order-item">
                    <div className="order-main">Todavía no hay atletas cargados</div>
                  </div>
                )}
              </div>
            </section>

            <div className="side-column">
              <section className="card">
                <h2>Mapa visual</h2>

                <div className="stack">
                  {groupedByExercise.length > 0 ? (
                    groupedByExercise.map(([exercise, athletes]) => (
                      <div className="exercise-group" key={exercise}>
                        <div className="exercise-group-head">
                          <strong>{exercise}</strong>
                          <span className="group-count">
                            {athletes.length} atleta{athletes.length === 1 ? "" : "s"}
                          </span>
                        </div>

                        <div className="tag-wrap">
                          {athletes.map((athlete) => (
                            <div className="person-tag" key={athlete.id}>
                              <strong>{athlete.name || "Sin nombre"}</strong>
                              <span>{statusLabel(athlete.status)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="order-item">
                      <div className="order-main">Todavía no hay mapa visual</div>
                    </div>
                  )}
                </div>
              </section>

              <section className="card">
                <h2>Orden de atención</h2>

                <div className="stack">
                  {attentionOrder.length > 0 ? (
                    attentionOrder.map((item, index) => (
                      <div
                        className="order-item order-timeline-item"
                        key={`${item.athleteId}-${item.step}-${index}`}
                      >
                        <div className="order-step-badge">{index + 1}</div>
                        <div className="order-content">
                          <div className="order-main">{item.athleteName || "Sin nombre"}</div>
                          <div className="order-sub">
                            {item.startExercise || "Sin ejercicio asignado"}
                          </div>
                        </div>
                        <div className={`order-tag ${attentionStepClass(item.step)}`}>
                          {item.step}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="order-item">
                      <div className="order-main">Todavía no hay orden generado</div>
                    </div>
                  )}
                </div>
              </section>

              <section className="card end-cta-card">
                <div className="session-card-actions" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={saveAndStartNewSession}
                    disabled={!canSaveSession || isSavingSession}
                    style={{ opacity: canSaveSession && !isSavingSession ? 1 : 0.5 }}
                  >
                    {isSavingSession ? "Guardando..." : "Guardar y nueva sesión"}
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
