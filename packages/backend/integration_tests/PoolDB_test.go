package integration_tests

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/FreiFahren/backend/database"
	"github.com/FreiFahren/backend/utils"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

var testPool *pgxpool.Pool

func CreatePoolTestTable() {
	sql := `
	CREATE TABLE IF NOT EXISTS pool_test (
		id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
		timestamp TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
		message TEXT,
		author BIGINT,
		line VARCHAR(3),
		station_id VARCHAR(250),
		direction_id VARCHAR(250)
	);
	`

	_, err := testPool.Exec(context.Background(), sql)
	if err != nil {
		fmt.Fprintf(os.Stderr, "(PoolDB_test.go) Failed to create pool table: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Table created or already exists.")
}

func InsertPoolInfo(timestamp *time.Time, message *string, author *int64, line, stationName, stationId, directionName, directionId *string) error {

	sql := `
    INSERT INTO pool_test (timestamp, message, author, line, station_id, direction_id)
    VALUES ($1, $2, $3, $4, $5, $6);
    `

	// Convert *string and *int64 directly to interface{} for pgx
	values := []interface{}{timestamp, message, author, line, stationId, directionId}

	_, err := testPool.Exec(context.Background(), sql, values...)

	if err != nil {
		fmt.Fprintf(os.Stderr, "(PoolDB_test.go) Failed to insert ticket info: %v\n", err)
		return err
	}
	return nil
}

func CreateTestPool() {
	var err error

	p, err := pgxpool.NewWithConfig(context.Background(), database.Config())
	if err != nil {
		log.Fatal("Error while creating connection to the database!!")
	}

	testPool = p

}

func setup() {
	// A .env is a convenience for running these locally, not a requirement. It fills in the
	// connection variables when they are not already in the environment, which is how CI provides
	// them, so its absence is not an error. Insisting on the file meant these tests could only ever
	// run on a developer machine.
	if envPath, err := utils.FindEnvFile(); err == nil {
		if err := godotenv.Load(envPath); err != nil {
			cwd, _ := os.Getwd()
			log.Printf("Ignoring unreadable .env at %s (working directory %s): %v", envPath, cwd, err)
		}
	}

	if os.Getenv("DB_HOST") == "" {
		log.Fatal("No database configured. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME, " +
			"or put them in a .env file above packages/backend.")
	}

	CreateTestPool()
	database.CreatePool()
	CreatePoolTestTable()
	// The tests below query `reports`, not the `pool_test` table above, so the schema the server
	// creates on start has to exist here too. Without this the package passes on any machine that
	// has run the server once and fails on a fresh database, which is every CI run.
	database.CreateReportsTable()
}

func teardown() {

	if testPool != nil {
		testPool.Close()
	}
	database.ClosePool()

}

func TestGetLatestStationCoordinatesConcurrency(t *testing.T) {
	setup()
	defer teardown()

	errs := make(chan error, 1000) // Buffer the channel to prevent goroutines from blocking

	var WaitGroup sync.WaitGroup
	for i := 0; i < 100; i++ {
		WaitGroup.Add(1)
		go func(i int) {
			defer WaitGroup.Done()

			t.Logf("Running test %d", i)

			// Call the function with the pool (on the real database)
			startTime := time.Now().UTC().Add(-time.Hour)
			endTime := time.Now().UTC()
			_, err := database.GetLatestTicketInspectors("berlin", startTime, endTime, "")
			if err != nil {
				errs <- err
			}

			remaining := 7
			currentStationIds := []string{"U-PL", "SUM-A", "SU-S"}

			_, err = database.GetHistoricStations("berlin", time.Now().UTC(), remaining, 24, currentStationIds)
			if err != nil {
				errs <- err
			}

			// Seed the random number generator with the current time
			rand.New(rand.NewSource(20))

			// Enter a random ticket info into the database (on the pool test table)

			now := time.Now().UTC()
			message := "Platz der Lufbrücke"
			author := rand.Int63()
			line := "U6"
			stationId := "U-PL"
			stationName := "Platz der Lufbrücke"
			directionName := "Alt-Tegel"
			directionId := "U-ATg"

			err = InsertPoolInfo(&now, &message, &author, &line, &stationName, &stationId, &directionName, &directionId)
			if err != nil {
				log.Fatalf("Failed to insert ticket info: %v", err)
			}

		}(i)
	}
	WaitGroup.Wait()

	close(errs) // Close the channel to signal that no more errors will be sent

	// Check if any errors were sent on the channel
	if err, ok := <-errs; ok {
		t.Fatalf("Failed to get latest station coordinates: %v", err)
	}
}
