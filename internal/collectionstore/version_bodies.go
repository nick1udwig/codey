package collectionstore

import (
	"database/sql"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
)

const bodyChunkBytes = 4096

// Keep large bodies out of revision JSON. All three writes share the caller's
// transaction, so a revision can never expose an incomplete chunk set.
func writeVersion(tx *sql.Tx, record c.Record) error {
	metadata := record
	metadata.Body = ""
	if _, err := tx.Exec("INSERT INTO versions VALUES(?,?,?)", record.ID, record.Revision, encode(metadata)); err != nil {
		return err
	}
	return writeVersionBody(tx, record)
}
func writeVersionBody(tx *sql.Tx, record c.Record) error {
	if _, err := tx.Exec("INSERT INTO version_bodies VALUES(?,?,?,?,?)", record.ID, record.Revision, len(record.Body), record.BodyHash, record.BodyComplete); err != nil {
		return err
	}
	stmt, err := tx.Prepare("INSERT INTO body_chunks VALUES(?,?,?,?)")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for start := 0; start < len(record.Body); start += bodyChunkBytes {
		if _, err = stmt.Exec(record.ID, record.Revision, start, []byte(record.Body[start:min(start+bodyChunkBytes, len(record.Body))])); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) bodyRange(id, revision string, start, end int64) (string, error) {
	if start == end {
		return "", nil
	}
	first := start / bodyChunkBytes * bodyChunkBytes
	rows, err := s.DB.Query("SELECT position,data FROM body_chunks WHERE record_id=? AND revision=? AND position>=? AND position<? ORDER BY position", id, revision, first, end)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	buffer := make([]byte, 0, int(end-first)+bodyChunkBytes)
	expected := first
	for rows.Next() {
		var position int64
		var chunk []byte
		if err = rows.Scan(&position, &chunk); err != nil {
			return "", err
		}
		if position != expected {
			return "", c.Fail("internal", "Incomplete revision body")
		}
		buffer = append(buffer, chunk...)
		expected += int64(len(chunk))
	}
	if err = rows.Err(); err != nil {
		return "", err
	}
	if int64(len(buffer)) < end-first {
		return "", c.Fail("internal", "Incomplete revision body")
	}
	return string(buffer[start-first : end-first]), nil
}

func migrateVersionBodies(tx *sql.Tx) error {
	rows, err := tx.Query("SELECT record_id,revision,data FROM versions WHERE NOT EXISTS (SELECT 1 FROM version_bodies b WHERE b.record_id=versions.record_id AND b.revision=versions.revision)")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, revision string
		var raw []byte
		if err = rows.Scan(&id, &revision, &raw); err != nil {
			return err
		}
		record, err := Decode[c.Record](raw)
		if err != nil {
			return err
		}
		record.ID = id
		record.Revision = revision
		if err = writeVersionBody(tx, record); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE versions SET data=json_remove(data,'$.body') WHERE record_id=? AND revision=?", id, revision); err != nil {
			return err
		}
	}
	return rows.Err()
}
