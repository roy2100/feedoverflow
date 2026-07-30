package store

import "database/sql"

// Podcast playback positions — the article_states.play_position/play_updated_at
// pair behind /api/podcast-progress. See docs/plan-podcast-progress-sqlite.md.
//
// Every write here is an UPDATE, never an upsert. A progress ping carries an
// article id and a number of seconds and nothing else, so inserting on a miss
// would mint a title-less, content-less article row that then shows up in every
// list. An episode can only be played from a list served out of article_states,
// so the row is always there; a miss means the article has since been trimmed
// (size cap) and dropping the position on the floor is the right answer.

// PlaybackProgress returns the most recently written positions, id → whole
// seconds, newest first and capped at limit. The DB keeps every position; the
// client only ever resumes something it listened to recently, and an unbounded
// map would grow with years of listening.
func PlaybackProgress(r *sql.DB, limit int) (map[string]int, error) {
	rows, err := r.Query(`
	  SELECT article_id, play_position
	    FROM article_states
	   WHERE play_position IS NOT NULL
	   ORDER BY COALESCE(play_updated_at, 0) DESC
	   LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var pos int
		if err := rows.Scan(&id, &pos); err != nil {
			return nil, err
		}
		out[id] = pos
	}
	return out, rows.Err()
}

// SavePlaybackProgress records where an episode got to, in whole seconds. now is
// epoch ms and only orders the read above.
func SavePlaybackProgress(w *sql.DB, id string, seconds int, now int64) error {
	_, err := w.Exec(
		`UPDATE article_states SET play_position = ?, play_updated_at = ? WHERE article_id = ?`,
		seconds, now, id)
	return err
}

// ClearPlaybackProgress forgets an episode's position, so playing it again starts
// at the top.
func ClearPlaybackProgress(w *sql.DB, id string) error {
	_, err := w.Exec(
		`UPDATE article_states SET play_position = NULL, play_updated_at = NULL WHERE article_id = ?`,
		id)
	return err
}
