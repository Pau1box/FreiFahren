package statistics

// Statistics is the shape the statistics endpoints answer with. It exists for the
// swagger annotations of the handlers, which reference it by name.
type Statistics struct {
	NumberOfReports int `json:"numberOfReports"`
}
