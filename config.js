export const SUPABASE_URL      = "https://wbkeaaoookrigeowhibt.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6India2VhYW9vb2tyaWdlb3doaWJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTEyODMsImV4cCI6MjA4NzY2NzI4M30.UNp_DWVxcrkliHjmPTfJD22zqcWpTWcFLfRj6XKXu3E";

export const ECI_SELECTORS = {
    stateName:    '.page-title h2 span',
    pagination:   '.custom-pagination .page-item .page-link',
    activePage:   '.custom-pagination .page-item.active .page-link',
    tableRows:    '.custom-table tbody tr',
    colName:      0,
    colEciId:     1,
    colRound:     7,
    colStatus:    8,
    declaredStatus: 'Result Declared',
};

export const CONFIG = {
    PAGE_FETCH_DELAY_MS:    800,
    PAGES_PER_BATCH:        5,
    CYCLE_PAUSE_MS:         10000,
    UPSERT_CHUNK_SIZE:      250,
    MAX_WRITE_ATTEMPTS:     3,
    DB_REFRESH_INTERVAL_MS: 60000,
    FETCH_TIMEOUT_MS:       60000,
    HEARTBEAT_INTERVAL_MS:  90000,
};
